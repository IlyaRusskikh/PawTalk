"""Shared host CLI. Windows checks Manager availability independently of auto-install."""
import argparse
import contextlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
from pathlib import Path
from types import SimpleNamespace
from . import bundles, preflight, release
from .config import DEFAULTS, atomic, lock, read_config, write_config, save, validate, source_file
from .controller import Controller
from .runtime import run
from .platforms import WINDOWS, TerminalMaintenance, WindowsConsole, admin, default_root, host, protect

MESSAGES = {
 'confirm':('Продолжить? [y/N]: ','Continue? [y/N]: '),
 'ip':('Подтвердите публичный IPv4','Confirm public IPv4'),
 'port':('Основной порт','Base port'),
 'chat':('Лимит истории, МиБ (0 = без ограничения)','History limit, MiB (0 = unlimited)'),
 'auto':('Включить автоматическое обновление сервера? (да/нет)','Enable automatic server updates? (yes/no)'),
 'auto_manager':('Включить автоматическое обновление Manager? (да/нет)','Enable automatic Manager updates? (yes/no)'),
 'invitation_unavailable':('Сервер уже настроен. Приглашения создают администраторы и модераторы в клиенте.','This server is already initialized. Administrators and moderators create invitations in the client.'),
 'updates':('Сквозное шифрование обязательно; ключ создаст клиент первого администратора. Обновление сервера прерывает звонок. Автообновление включает сервер и средство его обслуживания.','End-to-end encryption is mandatory; the first administrator client creates the key. Server updates interrupt calls. Automatic updates include the server and its maintenance tool.'),
 'docker':('Установить Docker из официального apt-репозитория?','Install Docker from its official apt repository?'),
 'installed':('Сервер установлен. Вступите по одноразовой ссылке первого администратора; она действует 24 часа.','Server installed. Join using the single-use first administrator link; it expires in 24 hours.'),
 'invitation':('Приглашение (вставьте только следующую строку в клиент):','Invitation (paste only the next line into the client):'),
 'existing':('Существующая комната сохранена; данные не сброшены.','Existing room preserved; data retained.'),
 'external':('Локальная проверка не подтверждает внешний TCP/UDP и голос из другой сети.','Local checks do not verify external TCP/UDP or voice from another network.'),
 'error':('Ошибка выполнения.','Operation failed.'),
 'download_error':('Не удалось скачать файлы с {host} после {attempts} попыток. Проверьте доступ к GitHub через вашу сеть/VPN и повторите установку.', 'Could not download files from {host} after {attempts} attempts. Check GitHub access through your network/VPN and retry installation.'),
 'changed':('Изменения применены.','Changes applied.'),
 'unchanged':('Изменений нет.','No changes.'),
 'restore':('Восстановить копию? Работающая комната будет остановлена.','Restore backup? The running room will stop.'),
 'restore_freshness':('Для обнаружения отката ролей и отзывов устройств нужны сохранившиеся проверяемые сведения новее копии.',
                      'Detecting rolled-back roles and device revocations requires surviving verifiable evidence newer than the backup.'),
 'uninstall':('Остановить комнату и таймеры? Данные и настройки сохранятся.','Stop room and timers? Data and settings will be kept.'),
 'healthy':('Работает','Healthy'),'unhealthy':('Ошибка проверки здоровья','Unhealthy'),
 'starting':('Запускается','Starting'),'unknown':('Состояние неизвестно','Unknown state'),
 'invalid_bool':('Введите да или нет (также принимаются yes/no и true/false).','Enter yes or no (true/false also accepted).'),
 'invalid_ip':('Введите корректный IPv4-адрес.','Enter a valid IPv4 address.'),
 'invalid_port':('Введите порт от 1024 до 65532.','Enter a port from 1024 to 65532.'),
 'invalid_chat':('Введите целое число от 0 до 1048576 МиБ.','Enter an integer from 0 to 1048576 MiB.'),
 'stop':('Остановить сервер? Текущие звонки прервутся.','Stop the server? Active calls will disconnect.'),
 'migration_prepare':('Остановить сервер и подготовить миграцию защищённого доступа?','Stop the server and prepare protected-access migration?'),
 'migration_activate':('Переключить сервер на API 3 после проверки подписи владельца?','Switch the server to API 3 after verifying the owner signature?'),
 'migration_rollback':('Восстановить резервную копию до миграции?','Restore the backup from before migration?'),
 'tui_backup_confirm':('Для создания копии работающий сервер временно остановится. Текущие звонки прервутся.','Creating a backup temporarily stops a running server and disconnects active calls.'),
 'tui_terminal':('Откройте интерактивный терминал. Для SSH выделите TTY (ssh -t).','Use an interactive terminal. For SSH, allocate a TTY (ssh -t).'),
 'tui_status':('Сервер {server} · Manager {manager} · {status}','Server {server} · Manager {manager} · {status}'),
 'tui_uninstalled':('Сервер не установлен.','Server is not installed.'),
 'tui_stopped':('Остановлен','Stopped'),
 'tui_refresh':('Обновить состояние','Refresh status'),
 'tui_logs':('Последние записи журнала','Recent logs'),
 'tui_doctor':('Проверить состояние','Check health'),
 'tui_start':('Запустить сервер','Start server'),
 'tui_stop':('Остановить сервер','Stop server'),
 'tui_server_update':('Проверить обновление сервера','Check for Server update'),
 'tui_manager_update':('Проверить обновление Manager','Check for Manager update'),
 'tui_backup':('Создать резервную копию','Create backup'),
 'tui_restore':('Восстановить из резервной копии','Restore from backup'),
 'tui_restore_confirm':('Восстановить {name}? Сервер вернётся к состоянию копии. Изменения после её создания исчезнут из активного сервера, текущие звонки прервутся.',
                         'Restore {name}? The server will return to the state in the backup. Later changes will disappear from the active server and active calls will disconnect.'),
 'tui_no_backups':('Резервных копий нет.','No backups available.'),
 'tui_section_keys':('↑↓ / PgUp PgDn Выбрать   Enter Открыть   Esc Назад','↑↓ / PgUp PgDn Select   Enter Open   Esc Back'),
 'tui_exit':('Выход','Exit'),
 'tui_choose':('Номер действия: ','Action number: '),
 'tui_invalid':('Выберите номер из меню.','Choose a number from the menu.'),
 'tui_return':('Enter — вернуться в меню','Enter to return to the menu'),
 'tui_empty':('Нет записей.','No entries.'),
 'tui_cancelled':('Отменено.','Cancelled.'),
 'tui_keys':('↑↓ Выбрать   Enter Открыть   Esc Выход','↑↓ Select   Enter Open   Esc Exit'),
 'tui_mouse':(' · Щелчок мышью',' · Mouse click'),
 'tui_scroll':('↑↓ / PgUp PgDn Прокрутка','↑↓ / PgUp PgDn Scroll'),
 'tui_back':('Назад','Back'),
 'tui_cancel':('Отмена','Cancel'),
 'tui_accept':('Подтвердить','Confirm'),
 'tui_resize':('Увеличьте высоту терминала','Increase the terminal height'),
 'tui_network':('Сеть','Network'),
 'tui_security':('Безопасность и история','Security and history'),
 'tui_encryption':('Сквозное шифрование обязательно. Ключи хранятся у клиентов.','End-to-end encryption is mandatory. Clients hold the encryption keys.'),
 'tui_overview':('Обзор','Overview'),
 'tui_updates':('Обновления','Updates'),
 'tui_backups':('Резервные копии','Backups'),
 'tui_diagnostics':('Диагностика','Diagnostics'),
 'tui_network_info':('Адрес и порты','Address and ports'),
 'tui_network_edit':('Изменить IP и порт','Edit IP and port'),
 'tui_encryption_title':('Сквозное шифрование','End-to-end encryption'),
 'tui_history':('Изменить лимит истории','Edit history limit'),
 'tui_install_server':('Установить обновление Server','Install Server update'),
 'tui_install_manager':('Установить обновление Manager','Install Manager update'),
 'tui_install_manifest':('Установить Server из подписанного манифеста','Install Server from a signed manifest'),
 'tui_install_zip':('Установить Server из ZIP','Install Server from ZIP'),
 'tui_auto_server':('Автообновление Server','Automatic Server updates'),
 'tui_auto_manager':('Автообновление Manager','Automatic Manager updates'),
 'tui_enabled':('Включить','Enable'),
 'tui_disabled':('Выключить','Disable'),
 'tui_on':('Включено','Enabled'),
 'tui_off':('Выключено','Disabled'),
 'tui_language':('Язык','Language'),
 'tui_initial_admin':('Приглашение первого администратора','First administrator invitation'),
 'tui_invitation_copy':('Скопируйте строку в PawTalk Client. Не передавайте её другим людям.','Copy the line into PawTalk Client. Keep it private.'),
 'tui_delete_backup':('Удалить резервную копию','Delete backup'),
 'tui_delete_confirm':('Удалить копию {name}? Она станет недоступна для восстановления.','Delete backup {name}? It will no longer be available for restore.'),
 'tui_setup':('Установить первый сервер','Set up the first server'),
 'tui_setup_confirm':('Начать установку с указанным адресом и настройками?','Install Server with the entered address and settings?'),
 'tui_published':('Опубликованный Server','Published Server'),
 'tui_local_manifest':('Подписанный манифест на диске','Signed manifest on disk'),
 'tui_local_zip':('ZIP-пакет Server на диске','Server ZIP package on disk'),
 'tui_zip_path':('Путь к ZIP-пакету Server','Path to the Server ZIP package'),
 'tui_zip_signed':('Подпись пакета проверена.','Package signature verified.'),
 'tui_zip_local':('У пакета нет подписи издателя. Подтверждайте только пакет из доверенного источника. Автообновление Server будет отключено.',
                  'The package has no publisher signature. Confirm only a package from a trusted source. Automatic Server updates will be disabled.'),
 'tui_manager_queued':('Установщик Manager запущен. После установки откройте TUI снова.','The Manager installer has been started. Reopen the TUI after it finishes.'),
 'tui_maintenance':('TUI закрыт для обслуживания Manager.','The TUI closed for Manager maintenance.'),
 'tui_admin_windows':('Откройте терминал от имени администратора.','Open the terminal as Administrator.'),
 'tui_manifest_path':('Путь к подписанному JSON-манифесту Server','Path to the signed Server JSON manifest'),
 'tui_manifest_missing':('Файл манифеста не найден.','Manifest file not found.'),
 'tui_port_hint':('Откройте TCP {base}, TCP {tcp} и UDP {udp} для клиентов. Внутренний TCP {internal} оставьте закрытым.','Allow client access to TCP {base}, TCP {tcp} and UDP {udp}. Keep internal TCP {internal} private.'),
 'tui_network_confirm':('Изменение адреса или порта прервёт текущие звонки. Старые приглашения и сохранённые адреса могут перестать работать. При смене IP сервер выпустит новый TLS-сертификат.',
                         'Changing the address or port disconnects active calls. Existing invitations and saved addresses may stop working. Changing the IP replaces the TLS certificate.'),
 'tui_history_confirm':('Изменение лимита прервёт текущие звонки. Уменьшение лимита может удалить старые сообщения.','Changing the limit disconnects active calls. Reducing it can remove older messages.'),
 'tui_server_update_confirm':('При установке Server прервутся текущие звонки.','Installing Server will disconnect active calls.'),
 'tui_stop_exit':('Остановить сервер и выйти','Stop Server and exit'),
 'tui_available':('Доступна версия {version}','Version {version} is available'),
 'tui_current':('Обновлений нет','Up to date'),
}


def text(key,lang):
    return MESSAGES[key][lang == 'en']


SETTINGS_FIELDS = {'PAWTALK_PUBLIC_IP','PAWTALK_PORT',
                   'PAWTALK_CHAT_MAX_MB','PAWTALK_SERVER_AUTO_UPDATE','PAWTALK_MANAGER_AUTO_UPDATE','PAWTALK_LANGUAGE'}


def apply_settings(controller,request):
    if not isinstance(request,dict) or set(request) != {'expected','values'}:
        raise ValueError('Invalid settings request')
    old = controller.config()
    if request['expected'] != old:
        raise ValueError('Settings changed elsewhere. Close this window and open it again.')
    values = request['values']
    if not isinstance(values,dict) or set(values) != SETTINGS_FIELDS or any(not isinstance(v,str) for v in values.values()):
        raise ValueError('Invalid settings fields')
    validate({**old,**values})
    if all(old[key] == value for key,value in values.items()):
        return False
    controller.configure(values)
    return True


def confirm(message,yes,lang):
    if yes:
        return
    if not sys.stdin.isatty():
        raise ValueError('Explicit --yes confirmation required in noninteractive mode')
    print(message)
    if input(text('confirm',lang)).strip().lower() not in ('y','yes','да'):
        raise ValueError('Cancelled')


def wizard(lang,initial=None,independent_updates=False):
    values = dict(DEFAULTS,**(initial or {}))
    values['PAWTALK_LANGUAGE'] = lang
    candidates = [] if initial else preflight.public_candidates()
    fields = [('ip','PAWTALK_PUBLIC_IP'),('port','PAWTALK_PORT'),('chat','PAWTALK_CHAT_MAX_MB'),('auto','PAWTALK_SERVER_AUTO_UPDATE')]
    if independent_updates:
        fields.append(('auto_manager','PAWTALK_MANAGER_AUTO_UPDATE'))
    values['PAWTALK_PUBLIC_IP'] = values.get('PAWTALK_PUBLIC_IP',candidates[0] if candidates else '')
    print(text('tui_encryption' if independent_updates else 'updates',lang))
    for key,field in fields:
        boolean = key in ('auto','auto_manager')
        default = 'true' if not initial and boolean else values[field]
        shown_default = (('да' if default == 'true' else 'нет') if lang == 'ru' else ('yes' if default == 'true' else 'no')) if boolean else default
        while True:
            response = input(text(key,lang)+(f' [{shown_default}]' if shown_default else '')+': ')
            # Minimal Python TTYs may return bracketed-paste delimiters literally.
            response = response.replace('\x1b[200~','').replace('\x1b[201~','').strip() or default
            if boolean:
                response = {'да':'true','yes':'true','true':'true','нет':'false','no':'false','false':'false'}.get(response.casefold())
                if response is None:
                    print(text('invalid_bool',lang))
                    continue
            else:
                try:
                    validate({**values,field:response})
                except ValueError:
                    print(text('invalid_'+key,lang))
                    continue
            values[field] = response
            if key == 'auto' and not independent_updates:
                values['PAWTALK_MANAGER_AUTO_UPDATE'] = response
            break
    return validate(values)


def manifest(file,component,keys):
    if not file:
        return release.discover(component,keys)
    with Path(file).open('rb') as stream:
        return release.verify(stream.read(16385),component,keys)


def doctor(controller,lang):
    result = dict(installed=controller.state_file.exists() and not (controller.directory/'setup.json').exists(),transactionPending=controller.journal.exists(),
                  freeMiB=shutil.disk_usage(controller.root).free//1048576,externalNetworkVerified=False)
    if not result['installed']:
        result.update(running=False,managerRunning=False)
        result['action'] = 'Manager UI: choose Server package and complete setup' if WINDOWS else 'pawtalkctl install / pawtalkctl backup restore'
        return result
    state,config = controller.state(),controller.config()
    result.update(serverVersion=state['version'],managerVersion=state['managerVersion'],image=state['image'])
    result['address'] = f'{config["PAWTALK_PUBLIC_IP"]}:{config["PAWTALK_PORT"]}'
    if WINDOWS:
        from .native import installed_desktop_version
        result['managerVersion'] = installed_desktop_version()
    for name in ['last-operation.json','last-error.json','health.json']:
        if (controller.directory/name).exists():
            result[name] = json.loads((controller.directory/name).read_text())
    try:
        info = controller.runtime.container(state,config)
        health = info['State'].get('Health',{}).get('Status','unknown')
        result['health'] = text(health if health in ('healthy','unhealthy','starting') else 'unknown',lang)
        result['running'] = bool(info['State'].get('Running'))
        result['identityOK'] = controller.runtime.identity(state,config) == state.get('identity') if health == 'healthy' else False
        result['action'] = 'pawtalkctl logs; pawtalkctl update check; pawtalkctl backup list'
    except (ValueError,RuntimeError):
        result['health'] = text('unknown',lang)
        result['action'] = 'docker info; docker compose version; systemctl status docker; pawtalkctl install'
    if WINDOWS:
        result['managerRunning'] = host('status-manager',controller.root).returncode == 0
    for name in ([] if WINDOWS else ['pawtalk-update.timer','pawtalk-health.timer']):
        if shutil.which('systemctl'):
            result[name] = subprocess.run(['systemctl','is-active','--quiet',name],capture_output=True).returncode == 0
    return result


TUI_SECTIONS = (
    ('tui_overview',(
        ('tui_refresh',()),('tui_start',('start',)),('tui_stop',('stop','--yes')),
        ('tui_initial_admin',None),('tui_setup',None),('tui_language',None),('tui_stop_exit',None),
    )),
    ('tui_network',(('tui_network_info',None),('tui_network_edit',None))),
    ('tui_security',(('tui_encryption_title',None),('tui_history',None))),
    ('tui_updates',(
        ('tui_server_update',('update','check','--details')),('tui_install_server',None),
        ('tui_install_manifest',None),('tui_auto_server',None),
        ('tui_manager_update',('manager','check','--details')),('tui_install_manager',None),('tui_auto_manager',None),
    )),
    ('tui_backups',(('tui_backup',('backup','create')),('tui_restore',None),('tui_delete_backup',None))),
    ('tui_diagnostics',(('tui_doctor',('doctor',)),('tui_logs',('logs',)))),
)
TUI_CONFIRMATIONS = {'tui_stop':'stop','tui_backup':'tui_backup_confirm'}


def terminal_output(value):
    # Logs and subprocess errors are data, including any embedded VT escapes.
    return re.sub(r'[\x00-\x08\x0b-\x1f\x7f-\x9f]', '', value.replace('\r\n','\n')).strip()


def backup_entries(directory):
    entries = []
    for path in directory.glob('backup-*'):
        metadata = path/'metadata.json'
        if not re.fullmatch(r'backup-[a-f0-9]{12}',path.name) or path.is_symlink() or metadata.is_symlink() or not metadata.is_file():
            continue
        try:
            meta = json.loads(metadata.read_text())
            created = meta['createdAt']
            if meta['schema'] == 1 and type(created) is int and 0 <= created <= 253402300799:
                entries.append(dict(name=path.name,created=created))
        except (OSError,ValueError,KeyError,TypeError):
            continue
    return sorted(entries,key=lambda entry:(entry['created'],entry['name']),reverse=True)


def tui_backups(lang,execute):
    code,output = execute('backup','list','--json')
    if code:
        return [],terminal_output(output) or text('error',lang)
    entries = json.loads(output)
    return entries,text('tui_no_backups',lang) if not entries else ''


def tui_backup_label(entry):
    date = time.strftime('%Y-%m-%d %H:%M UTC',time.gmtime(entry['created']))
    return f'{date}  {entry["name"]}'


def tui_numbered_choice(lang,items,exit_label):
    for number,label in enumerate(items,1):
        print(f'  {number}. {label}')
    print(f'  0. {exit_label}')
    choices = {str(index+1):index for index in range(len(items))}
    while (choice := input(text('tui_choose',lang)).strip()) not in choices and choice != '0':
        print(text('tui_invalid',lang))
    return choices.get(choice)


def tui_prompt(label,default=None):
    suffix = f' [{default}]' if default is not None else ''
    value = input(f'{label}{suffix}: ').replace('\x1b[200~','').replace('\x1b[201~','').strip()
    return None if value == '\x1b' else (value or default)


def tui_result(lang,code,output,command=()):
    if not code and command in (('update','check','--details'),('manager','check','--details')):
        checked = json.loads(output)
        return text('tui_available',lang).format(version=checked['version']) if checked['available'] else text('tui_current',lang)
    return terminal_output(output) or text('error' if code else 'tui_empty',lang)


def tui_settings(lang,execute,ui,heading):
    code,output = execute('settings')
    if code:
        ui.show(heading,tui_result(lang,code,output))
        return None
    return json.loads(output)['values']


def tui_configure(ui,heading,changes):
    return ui.run(heading,('configure',*(f'{key}={value}' for key,value in changes.items()),'--yes'))


def tui_manifest_path(lang,ui,heading):
    value = ui.prompt(text('tui_manifest_path',lang))
    if value is None:
        return None
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        ui.show(heading,text('tui_manifest_missing',lang))
        return None
    return str(path)


def tui_install_update(lang,execute,ui,heading,component,file=None):
    options = ('--manifest',file) if file else ()
    code,output = execute(component,'check','--details',*options)
    if code:
        ui.show(heading,tui_result(lang,code,output))
        return
    update = json.loads(output)
    if not update['available']:
        ui.show(heading,text('tui_current',lang))
        return
    details = text('tui_available',lang).format(version=update['version'])
    if file:
        details += '\n'+update['digest']
    if component == 'update':
        details += '\n\n'+text('tui_server_update_confirm',lang)
    if ui.approve(heading,details):
        # Use the exact checked manifest even if a newer release appears before confirmation.
        with tempfile.TemporaryDirectory(prefix='pawtalk-tui-') as work:
            checked = Path(work)/'manifest.json'
            atomic(checked,update['manifest'].encode())
            command = (component,'now','--manifest',str(checked))
            if WINDOWS and component == 'manager':
                code,output = execute(*command)
                if code == 0:
                    ui.plain(lambda: print(text('tui_manager_queued',lang),flush=True))
                    return 'exit'
                ui.show(heading,tui_result(lang,code,output))
            else:
                ui.run(heading,command)


def tui_windows_package(lang,execute,ui,heading,replacing=False):
    value = ui.prompt(text('tui_zip_path',lang))
    if value is None:
        return None
    raw = value.strip('"') # Paste as path in Explorer includes surrounding quotes.
    path = str(Path(raw).expanduser().resolve())
    code,output = execute('terminal-package','inspect',path)
    if code:
        ui.show(heading,tui_result(lang,code,output))
        return None
    package = json.loads(output)
    trust = text('tui_zip_signed' if package['verified'] else 'tui_zip_local',lang)
    details = f'Server {package["version"]}\n\nSHA-256: {package["sha256"]}\n\n{trust}'
    if replacing:
        details += '\n\n'+text('tui_server_update_confirm',lang)
    return package['id'] if ui.approve(heading,details) else None


def tui_update_action(key,lang,execute,ui,heading):
    if key in ('tui_install_server','tui_install_manifest'):
        if WINDOWS and key == 'tui_install_manifest':
            package = tui_windows_package(lang,execute,ui,heading,replacing=True)
            if package:
                ui.run(heading,('terminal-package','install',package))
            return None
        file = tui_manifest_path(lang,ui,heading) if key == 'tui_install_manifest' else None
        if key == 'tui_install_server' or file:
            tui_install_update(lang,execute,ui,heading,'update',file)
    elif key == 'tui_install_manager':
        return tui_install_update(lang,execute,ui,heading,'manager')
    else:
        values = tui_settings(lang,execute,ui,heading)
        if values is None:
            return
        field = 'PAWTALK_SERVER_AUTO_UPDATE' if key == 'tui_auto_server' else 'PAWTALK_MANAGER_AUTO_UPDATE'
        status = text('tui_on' if values[field] == 'true' else 'tui_off',lang)
        choice = ui.choose(heading,[text('tui_enabled',lang),text('tui_disabled',lang)],status=status)
        if choice is not None:
            tui_configure(ui,heading,{field:('true','false')[choice]})


def tui_network_inputs(lang,old_ip,old_port):
    ip = tui_prompt(text('ip',lang),old_ip)
    port = tui_prompt(text('port',lang),old_port) if ip is not None else None
    return (ip,port) if port is not None else None


def tui_label(key,lang):
    return text('tui_install_zip' if WINDOWS and key == 'tui_install_manifest' else key,lang)


def tui_extra(key,lang,execute,ui):
    heading = tui_label(key,lang)
    if key == 'tui_language':
        choice = ui.choose(heading,['Русский','English'])
        if choice is not None:
            language = ('ru','en')[choice]
            code,output = execute('status')
            if code:
                ui.show(heading,tui_result(lang,code,output))
            elif not json.loads(output)['installed']:
                execute('tui-language',language)
                return language
            elif tui_configure(ui,heading,{'PAWTALK_LANGUAGE':language}) == 0:
                return language
    elif key == 'tui_encryption_title':
        ui.show(heading,text('tui_encryption',lang))
    elif key in ('tui_network_info','tui_network_edit','tui_history'):
        values = tui_settings(lang,execute,ui,heading)
        if values is None:
            return None
        if key == 'tui_history':
            old_limit = values['PAWTALK_CHAT_MAX_MB']
            limit = ui.prompt(text('chat',lang),old_limit)
            if limit is not None and limit != old_limit and ui.approve(heading,text('tui_history_confirm',lang)):
                tui_configure(ui,heading,{'PAWTALK_CHAT_MAX_MB':limit})
        else:
            old_ip,old_port = (values[field] for field in ('PAWTALK_PUBLIC_IP','PAWTALK_PORT'))
            if key == 'tui_network_info':
                port = int(old_port)
                ui.show(heading,f'{old_ip}:{old_port}\n\n'+text('tui_port_hint',lang).format(base=port,tcp=port+1,udp=port+2,internal=port+3))
            else:
                address = ui.plain(lambda: tui_network_inputs(lang,old_ip,old_port))
                if address is not None and address != (old_ip,old_port) and ui.approve(heading,text('tui_network_confirm',lang)):
                    ip,port = address
                    tui_configure(ui,heading,{'PAWTALK_PUBLIC_IP':ip,'PAWTALK_PORT':port})
    elif key in ('tui_install_server','tui_install_manager','tui_install_manifest','tui_auto_server','tui_auto_manager'):
        return tui_update_action(key,lang,execute,ui,heading)
    elif key in ('tui_restore','tui_delete_backup'):
        entries,problem = tui_backups(lang,execute)
        if not entries:
            ui.show(heading,problem)
            return None
        choice = ui.choose(heading,[tui_backup_label(entry) for entry in entries])
        if choice is not None:
            name = entries[choice]['name']
            action,message = ('restore','tui_restore_confirm') if key == 'tui_restore' else ('delete','tui_delete_confirm')
            prompt = text(message,lang).format(name=name)
            if action == 'restore':
                prompt += '\n\n' + text('restore_freshness',lang)
            if ui.approve(heading,prompt):
                ui.run(heading,('backup',action,name,'--yes'))
    elif key == 'tui_initial_admin':
        code,output = execute('initial-admin','--url')
        if code:
            ui.show(heading,tui_result(lang,code,output))
        else:
            ui.plain(lambda: print(text('tui_invitation_copy',lang)+'\n\n'+terminal_output(output)),True)
    elif key == 'tui_setup':
        code,output = execute('status')
        if code or json.loads(output)['installed']:
            ui.show(heading,tui_result(lang,code,output) if code else text('existing',lang))
            return None
        choice = ui.choose(heading,[text('tui_published',lang),text('tui_local_zip' if WINDOWS else 'tui_local_manifest',lang)])
        if choice is not None:
            if WINDOWS:
                package = tui_windows_package(lang,execute,ui,heading) if choice else None
                if choice and package is None:
                    return None
                old = tui_settings(lang,execute,ui,heading)
                if old is None:
                    return None
                values = ui.plain(lambda: wizard(lang,old,independent_updates=True))
                if values is not None and ui.approve(heading,text('tui_setup_confirm',lang)):
                    payload = dict(source='local' if choice else 'published',id=package,expected=old,
                                   values={key:values[key] for key in SETTINGS_FIELDS})
                    ui.run(heading,('terminal-setup',payload))
                return None
            file = tui_manifest_path(lang,ui,heading) if choice else None
            if not choice or file:
                options = ('--server-manifest',file) if file else ()
                ui.plain(lambda: execute('install','--new',*options),True)
    elif key == 'tui_stop_exit' and ui.approve(heading,text('stop',lang)):
        if ui.run(heading,('stop','--yes')) == 0:
            return 'exit'
    return None


def tui_status(lang,execute):
    code,output = execute('status')
    if code:
        return terminal_output(output) or text('unknown',lang)
    status = json.loads(output)
    if not status['installed']:
        return text('tui_uninstalled',lang)
    health = status['health'] if status.get('running',True) else text('tui_stopped',lang)
    summary = text('tui_status',lang).format(server=status['serverVersion'],manager=status['managerVersion'],status=health)
    if status.get('address'):
        summary += ' · '+status['address']
    return terminal_output(summary)


def tui_navigation(execute,ui):
    section = None
    root_selection = action_selection = 0
    while True:
        lang = ui.lang
        status = tui_status(lang,execute)
        if section is None:
            labels = [text(key,lang) for key,_ in TUI_SECTIONS]
            choice = ui.choose('PawTalk Manager',labels,status=status,selected=root_selection,root=True)
            if choice is None:
                return 0
            root_selection = choice
            section = TUI_SECTIONS[choice]
            action_selection = 0
            continue
        section_key,actions = section
        labels = [tui_label(key,lang) for key,_ in actions]
        choice = ui.choose(text(section_key,lang),labels,status=status,selected=action_selection)
        if choice is None:
            section = None
            continue
        action_selection = choice
        key,command = actions[choice]
        if command is None:
            next_view = tui_extra(key,lang,execute,ui)
            if next_view == 'exit':
                return 0
            ui.lang = next_view or lang
        elif command:
            heading = text(key,lang)
            confirmation = TUI_CONFIRMATIONS.get(key)
            if not confirmation or ui.approve(heading,text(confirmation,lang)):
                ui.run(heading,command)


def tui(lang,execute):
    def show(heading,message):
        print(f'\n{heading}\n\n{message}')
        input(f'\n{text("tui_return",ui.lang)} ')

    def approve(heading,message):
        print(f'\n{heading}')
        try:
            confirm(message,False,ui.lang)
        except ValueError:
            print(text('tui_cancelled',ui.lang))
            return False
        return True

    def run_action(heading,command):
        print(f'\n{heading}…',flush=True)
        code,output = execute(*command)
        show(heading,tui_result(ui.lang,code,output,command))
        return code

    def plain(operation,pause=False):
        result = operation()
        if pause:
            input(f'\n{text("tui_return",ui.lang)} ')
        return result

    def choose(heading,items,*,status='',selected=0,root=False):
        print(f'\n{heading}')
        if status:
            print(status)
        return tui_numbered_choice(ui.lang,items,text('tui_exit' if root else 'tui_back',ui.lang))

    ui = SimpleNamespace(lang=lang,choose=choose,show=show,approve=approve,prompt=tui_prompt,run=run_action,plain=plain)
    try:
        return tui_navigation(execute,ui)
    except EOFError:
        return 0
    except KeyboardInterrupt:
        print()
        return 130


def tui_line(screen,row,value,style='normal'):
    height,width = screen.dimensions()
    if 0 <= row < height and width > 2:
        screen.draw(row,1,value[:width-2],style)


class CursesConsole:
    def __init__(self,screen,curses):
        self.screen,self.curses = screen,curses
        with contextlib.suppress(curses.error):
            curses.curs_set(0)
        self.mouse = bool(curses.mousemask(curses.BUTTON1_PRESSED)[0])
        self.dimensions = screen.getmaxyx
        self.clear = screen.erase
        self.refresh = screen.refresh

    def draw(self,row,column,value,style):
        curses = self.curses
        attr = {'normal':0,'bold':curses.A_BOLD,'dim':curses.A_DIM,'selected':curses.A_REVERSE}
        # Wide log characters may reach the terminal edge before the slice ends.
        with contextlib.suppress(curses.error):
            self.screen.addstr(row,column,value,attr[style])

    def read(self):
        curses = self.curses
        key = self.screen.getch()
        if key == curses.KEY_MOUSE:
            with contextlib.suppress(curses.error):
                _,x,y,_,state = curses.getmouse()
                if state & curses.BUTTON1_PRESSED:
                    return 'click',x,y
        names = {-1:'back',9:'tab',10:'enter',13:'enter',27:'back',ord('q'):'back',
                 curses.KEY_ENTER:'enter',curses.KEY_UP:'up',curses.KEY_DOWN:'down',
                 curses.KEY_PPAGE:'page_up',curses.KEY_NPAGE:'page_down'}
        return names.get(key),-1,-1

    @contextlib.contextmanager
    def suspend(self):
        self.curses.def_prog_mode()
        self.curses.endwin()
        try:
            yield
        finally:
            self.curses.reset_prog_mode()
            self.screen.clearok(True)


def tui_panel(screen,lang,heading,body,buttons=()):
    selected = offset = 0
    wrap_width = None
    while True:
        height,width = screen.dimensions()
        button_row = max(2,height-len(buttons))
        page = max(0,button_row-3)
        if width != wrap_width:
            wrap_width = width
            wrap = textwrap.TextWrapper(width=max(1,width-2),replace_whitespace=False,drop_whitespace=False)
            lines = [part for line in body.split('\n') for part in (wrap.wrap(line) or [''])]
        limit = max(0,len(lines)-page)
        offset = min(offset,limit)
        screen.clear()
        tui_line(screen,0,heading,'bold')
        for row,line in enumerate(lines[offset:offset+page],2):
            tui_line(screen,row,line)
        if limit and page:
            tui_line(screen,button_row-1,f'{text("tui_scroll",lang)}  {offset+1}–{min(offset+page,len(lines))}/{len(lines)}')
        if page:
            for index,button in enumerate(buttons):
                tui_line(screen,button_row+index,button,'selected' if index == selected else 'normal')
        elif buttons:
            tui_line(screen,height-1,text('tui_resize',lang))
        screen.refresh()
        if not buttons:
            return False
        key,x,y = screen.read()
        if key == 'back':
            return False
        if not page:
            continue
        if 0 <= y-button_row < len(buttons) and 1 <= x <= len(buttons[y-button_row]):
            return y-button_row == len(buttons)-1
        if key == 'enter':
            return selected == len(buttons)-1
        if len(buttons) > 1 and key in ('tab','up','down'):
            selected = (selected+1) % len(buttons)
        else:
            step = {'up':-1,'down':1,'page_up':-max(1,page),'page_down':max(1,page)}
            offset = max(0,min(limit,offset+step.get(key,0)))


def tui_select(screen,lang,heading,status,items,hint,selected=0):
    first = 0
    while True:
        height,_ = screen.dimensions()
        visible = max(0,height-5)
        if visible:
            first = max(0,min(first,len(items)-visible))
            first = min(selected,max(first,selected-visible+1))
        screen.clear()
        tui_line(screen,0,heading,'bold')
        tui_line(screen,2,status)
        for index,label in enumerate(items[first:first+visible],first):
            caption = ('› ' if index == selected else '  ')+label
            tui_line(screen,4+index-first,caption,'selected' if index == selected else 'normal')
        tui_line(screen,height-1,hint if visible else text('tui_resize',lang),'dim')
        screen.refresh()
        key,x,y = screen.read()
        if key == 'back':
            return None
        if key in ('up','down'):
            selected = (selected+(-1 if key == 'up' else 1)) % len(items)
            continue
        if key in ('page_up','page_down'):
            selected = max(0,min(len(items)-1,selected+(-visible if key == 'page_up' else visible)))
            continue
        clicked = first+y-4
        if 4 <= y < 4+visible and clicked < len(items) and 1 <= x <= 2+len(items[clicked]):
            return clicked
        if visible and key == 'enter':
            return selected


def tui_screen(screen,lang,execute):
    def choose(heading,items,*,status='',selected=0,root=False):
        exit_label = text('tui_exit' if root else 'tui_back',ui.lang)
        hint = text('tui_keys' if root else 'tui_section_keys',ui.lang)
        if screen.mouse:
            hint += text('tui_mouse',ui.lang)
        choice = tui_select(screen,ui.lang,heading,status,[*items,exit_label],hint,selected)
        return None if choice == len(items) else choice

    def show(heading,message):
        tui_panel(screen,ui.lang,heading,message,(text('tui_back',ui.lang),))

    def approve(heading,message):
        return tui_panel(screen,ui.lang,heading,message,(text('tui_cancel',ui.lang),text('tui_accept',ui.lang)))

    def run_action(heading,command):
        tui_panel(screen,ui.lang,heading+'…','')
        code,output = execute(*command)
        show(heading,tui_result(ui.lang,code,output,command))
        return code

    def plain(operation,pause=False):
        with screen.suspend():
            try:
                print(flush=True)
                result = operation()
                if pause:
                    input(f'\n{text("tui_return",ui.lang)} ')
                return result
            except EOFError:
                return None
            finally:
                print(flush=True)

    def prompt(label,default=None):
        return plain(lambda: tui_prompt(label,default))

    ui = SimpleNamespace(lang=lang,choose=choose,show=show,approve=approve,prompt=prompt,run=run_action,plain=plain)
    return tui_navigation(execute,ui)


def fullscreen_tui(lang,execute):
    if WINDOWS:
        try:
            screen = WindowsConsole()
            with screen.active():
                return tui_screen(screen,lang,execute)
        except TerminalMaintenance:
            print(text('tui_maintenance',lang),flush=True)
            return 0
        except OSError:
            return tui(lang,execute)
        except KeyboardInterrupt:
            return 130
    try:
        import curses
    except ImportError:
        return tui(lang,execute)
    try:
        curses.setupterm(fd=sys.stdout.fileno())
        if curses.tigetstr('cup'):
            curses.set_escdelay(150)
            return curses.wrapper(lambda screen: tui_screen(CursesConsole(screen,curses),lang,execute))
    except curses.error:
        pass
    except KeyboardInterrupt:
        return 130
    return tui(lang,execute)


def tui_main(args,lang,controller):
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        raise ValueError(text('tui_terminal',lang))
    if args.lang is None:
        if WINDOWS:
            from .native import manager_values
            lang = manager_values(controller,lang)['PAWTALK_LANGUAGE']
        elif controller.state_file.exists():
            lang = controller.config()['PAWTALK_LANGUAGE']
    options = ['--root',str(controller.root),'--lang',lang]
    if args.no_systemd:
        options.append('--no-systemd')

    def execute(*command):
        if command[0] == 'tui-language':
            options[3] = command[1]
            return 0,''
        if WINDOWS and command[0] in ('settings','configure','terminal-package','terminal-setup','backup'):
            result = windows_tui_operation(controller,options[3],command)
            if result is not None:
                code,output = result
                if code == 0 and command[0] == 'configure':
                    for value in command[1:]:
                        if value.startswith('PAWTALK_LANGUAGE='):
                            options[3] = value.partition('=')[2]
                return code,output
        script = Path(__file__).resolve().parent.parent/'pawtalkctl'
        entry = [sys.executable,'-B','-X','utf8','-I',str(script),*options,*command]
        if command[0] == 'install':
            return subprocess.run(entry).returncode,''
        if command[:2] == ('backup','restore'):
            # Fresh-host restore may hand off to another verified Manager via exec.
            result = subprocess.run(entry,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,encoding='utf-8',errors='replace')
            return result.returncode,result.stdout
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            code = main([*options,*command])
        if code == 0 and command[0] == 'configure':
            for value in command[1:]:
                if value.startswith('PAWTALK_LANGUAGE='):
                    options[3] = value.partition('=')[2]
        return code,output.getvalue()

    return fullscreen_tui(lang,execute)


def windows_tui_operation(controller,lang,command):
    from .native import manager_values
    import zipfile

    action = command[0]
    if action == 'backup' and (command[1] != 'restore' or not controller.state_file.exists()):
        return None
    try:
        if action == 'settings':
            return 0,json.dumps(dict(values=manager_values(controller,lang)))
        with lock(controller.directory/'operation.lock',timeout=10):
            pending = (controller.directory/'setup.json').exists()
            if not pending:
                controller.recover()
            if action == 'terminal-setup':
                desktop_execute(controller,'setup-server',command[1])
                return 0,text('installed',lang)
            if command[:2] == ('terminal-package','inspect'):
                return 0,json.dumps(desktop_execute(controller,'inspect-server-package',dict(path=command[2])))
            if not controller.state_file.exists() or pending:
                raise ValueError('No installed room')
            if action == 'configure':
                old = controller.config()
                changes = dict(value.split('=',1) for value in command[1:] if value != '--yes')
                if not changes.keys() <= SETTINGS_FIELDS:
                    raise ValueError('Invalid settings fields')
                values = {key:changes.get(key,old[key]) for key in SETTINGS_FIELDS}
                apply_settings(controller,dict(expected=old,values=values))
                publish_desktop_status(controller)
            elif action == 'terminal-package':
                desktop_execute(controller,'install-server-package',dict(id=command[2]))
            else:
                name = command[2]
                meta,_ = controller.snapshot(name)
                state = meta['state']
                if state.get('localPackage'):
                    if state['localPackage'] != state['windows']['sha256']:
                        raise ValueError('Backup local Server artifact differs from the package receipt')
                else:
                    keys = json.loads((controller.etc/'trust.json').read_text())
                    release.verify_snapshot(meta,keys)
                desktop_execute(controller,'backup-restore',dict(name=name))
            return 0,text('changed',lang)
    except (OSError,ValueError,RuntimeError,KeyError,subprocess.SubprocessError,zipfile.BadZipFile) as error:
        return 1,text('error',lang)+' '+str(error)


def arguments(argv):
    p = argparse.ArgumentParser(description='PawTalk VPS CLI / Управление VPS')
    p.add_argument('--root',default=default_root())
    p.add_argument('--lang',choices=['ru','en'])
    p.add_argument('--no-systemd',action='store_true',help='Container/local verification only')
    p.add_argument('--self-test',action='store_true')
    sub = p.add_subparsers(dest='command')
    install = sub.add_parser('install')
    for key in ['config','trust','server-manifest','manager-manifest','bundle','server-bundle']:
        install.add_argument('--'+key)
    install.add_argument('--bootstrap-docker',action='store_true')
    install.add_argument('--new',action='store_true')
    invitation = sub.add_parser('initial-admin')
    invitation.add_argument('--url',action='store_true')
    for name in ['status','doctor','logs','periodic','health','run-server','setup','tui','start']:
        sub.add_parser(name)
    stop = sub.add_parser('stop')
    stop.add_argument('--yes',action='store_true')
    settings = sub.add_parser('settings')
    settings.add_argument('--apply',action='store_true')
    desktop = sub.add_parser('desktop')
    desktop.add_argument('action',choices=['snapshot','apply','initial-admin','backup-create','backup-restore','backup-delete','diagnostics','logs','check-updates','check-server-updates','install-manager-update','install-server-update','inspect-server-package','install-server-package','setup-server'])
    sub.add_parser('manager-install')
    config = sub.add_parser('configure')
    config.add_argument('values',nargs='+',help='PAWTALK_FIELD=value')
    config.add_argument('--yes',action='store_true')
    for name in ['update','manager']:
        update = sub.add_parser(name)
        update.add_argument('action',choices=['check','now'])
        update.add_argument('--manifest')
        update.add_argument('--details',action='store_true')
        if name == 'manager':
            update.add_argument('--bundle')
    backup = sub.add_parser('backup')
    backup.add_argument('action',choices=['create','list','restore','delete'])
    backup.add_argument('name',nargs='?')
    backup.add_argument('--yes',action='store_true')
    backup.add_argument('--json',action='store_true')
    backup.add_argument('--trust')
    migration = sub.add_parser('migration')
    migration.add_argument('action',choices=['prepare','status','activate','rollback'])
    migration.add_argument('--yes',action='store_true')
    migration.add_argument('--approval',type=Path)
    uninstall = sub.add_parser('uninstall')
    uninstall.add_argument('--keep-data',action='store_true',required=True)
    uninstall.add_argument('--yes',action='store_true')
    args = p.parse_args(argv)
    if not args.command and not args.self_test:
        p.error('Choose a command')
    return args


def handoff(command):
    """Wait through the verified installer on Windows; CRT exec returns early."""
    if WINDOWS:
        # Windows execv spawns a successor then exits the original PID with 0.
        # NSIS/SCM must instead observe the successor's completion and exit code.
        raise SystemExit(subprocess.call(command))
    os.execv(command[0],command)


UNFETCHED = object()


def discover_desktop(component,keys):
    deadline=time.monotonic()+15
    def get(url,limit=1024*1024,api=False):
        remaining=deadline-time.monotonic()
        if remaining<=0: raise TimeoutError('Update check timed out')
        return release.fetch(url,limit,api,timeout=min(5,remaining),attempts=1)
    return release.discover(component,keys,get=get)


def desktop_updates(controller,keys,install=False,*,component='manager',found=UNFETCHED):
    config,state = controller.config(),controller.state()
    try:
        if found is UNFETCHED: found = discover_desktop(component,keys)
    except (OSError,ValueError,RuntimeError):
        save(controller.directory/(component+'-update.json'),dict(status='check-failed',checkedAt=int(time.time())))
        publish_desktop_status(controller)
        raise
    from .native import installed_desktop_version, manager_installer_field
    if WINDOWS and component == 'manager' and found is not None:
        field = manager_installer_field()
        if field == 'windowsTuiInstaller' and field not in found:
            found = None
    current=(installed_desktop_version() if WINDOWS else state['managerVersion']) if component=='manager' else state['version']
    available = found is not None and (release.semver(found['version']) > release.semver(current) or (component=='server' and state.get('localPackage') and release.semver(found['version'])==release.semver(current)))
    status = dict(status='available' if available else 'current',version=found['version'] if available else None,checkedAt=int(time.time()))
    save(controller.directory/(component+'-update.json'),status)
    if available and install:
        if component=='manager': bundles.activate(controller,found,keys)
        else: controller.update_server(found)
        status['status']='installing'
        if component=='server': status=dict(status='current',checkedAt=int(time.time()))
        save(controller.directory/(component+'-update.json'),status)
    publish_desktop_status(controller)
    return status


def desktop_check(controller,component,install=False,force=False):
    # Metadata requests must never hold the room's mutation/recovery lock.
    with lock(controller.directory/'operation.lock',timeout=10):
        keys=json.loads((controller.etc/'trust.json').read_text())
    try:
        found=discover_desktop(component,keys)
    except (OSError,ValueError,RuntimeError):
        with lock(controller.directory/'operation.lock',timeout=10):
            save(controller.directory/(component+'-update.json'),dict(status='check-failed',checkedAt=int(time.time())))
            publish_desktop_status(controller)
        raise
    with lock(controller.directory/'operation.lock',timeout=10):
        controller.recover()
        # Configuration may have changed while GitHub was being contacted.
        auto=install and (force or controller.config()['PAWTALK_'+component.upper()+'_AUTO_UPDATE']=='true')
        return desktop_updates(controller,keys,install=auto,component=component,found=found)


def windows_periodic(controller):
    for component in ('manager','server'):
        try:
            status=desktop_check(controller,component,install=True)
            if status['status']=='installing': break
        except (OSError,ValueError,RuntimeError):
            pass # Independent checks retry on the next service tick.
    return 0


def publish_desktop_status(controller):
    if not WINDOWS: return
    from .native import manager_values, installed_desktop_version, manager_installer_field
    if manager_installer_field() == 'windowsTuiInstaller': return
    file=controller.directory/'manager-update.json'
    status=json.loads(file.read_text()) if file.exists() else dict(status='idle')
    config=manager_values(controller)
    installed=controller.state_file.exists() and not (controller.directory/'setup.json').exists()
    value=dict(update=status,language=config['PAWTALK_LANGUAGE'],autoManager=config['PAWTALK_MANAGER_AUTO_UPDATE']=='true',serverVersion=controller.state()['version'] if installed else '0.0.0',managerVersion=installed_desktop_version(),setupRequired=not installed)
    # The install directory has a different ACL policy from private room data.
    # Only the host publishes this allowlisted, nonsecret document for the UI.
    if host('publish-desktop-status',controller.root,input=json.dumps(value).encode()).returncode:
        raise ValueError('Unable to publish Manager status')


def desktop_execute(controller,action,request):
    if action == 'snapshot':
        publish_desktop_status(controller)
        if WINDOWS and (not controller.state_file.exists() or (controller.directory/'setup.json').exists()):
            from .native import manager_values,installed_desktop_version
            return dict(setupRequired=True,values=manager_values(controller),serverVersion='0.0.0',managerVersion=installed_desktop_version(),initialized=None,serverLocal=False,backups=[],update=dict(status='idle'),serverUpdate=dict(status='idle'))
        updates=controller.directory/'manager-update.json'
        server_updates=controller.directory/'server-update.json'
        return dict(setupRequired=False,values=controller.config(),serverVersion=controller.state()['version'],
                    initialized=controller.runtime.initialized(controller.state(),controller.config()),
                    serverLocal=bool(controller.state().get('localPackage')),
                    managerVersion=controller.state()['managerVersion'],
                    update=json.loads(updates.read_text()) if updates.exists() else dict(status='idle'),
                    serverUpdate=json.loads(server_updates.read_text()) if server_updates.exists() else dict(status='idle'),
                    backups=[dict(name=p.name,created=int(p.stat().st_mtime)) for p in sorted(controller.backups.glob('backup-*'),reverse=True) if p.is_dir() and re.fullmatch(r'backup-[a-f0-9]{12}',p.name)])
    if action == 'setup-server':
        from .native import setup_server
        setup_server(controller,request,Path(__file__).resolve().parent.parent)
        return desktop_execute(controller,'snapshot',{})
    if action == 'apply':
        if WINDOWS and (not controller.state_file.exists() or (controller.directory/'setup.json').exists()):
            from .native import manager_values
            old=manager_values(controller)
            if not isinstance(request,dict) or set(request)!={'expected','values'} or request['expected']!=old: raise ValueError('Settings changed elsewhere')
            values=request['values']
            if not isinstance(values,dict) or set(values)!=SETTINGS_FIELDS: raise ValueError('Invalid settings fields')
            write_config(controller.etc/'config.env',validate({**old,**values}))
        else: apply_settings(controller,request)
        return desktop_execute(controller,'snapshot',{})
    if action=='inspect-server-package':
        from .native import inspect_server_package
        return inspect_server_package(controller,request.get('path',''))
    if action=='install-server-package':
        from .native import install_server_package
        install_server_package(controller,request.get('id'))
        save(controller.directory/'server-update.json',dict(status='idle'))
        return desktop_execute(controller,'snapshot',{})
    if action == 'initial-admin':
        value=controller.runtime.invitation(controller.state(),controller.config())
        if value is None: return dict(unavailable=True)
        return value
    if action == 'backup-create':
        name=controller.create_backup()
        return dict(**desktop_execute(controller,'snapshot',{}),name=name)
    if action == 'backup-delete':
        controller.delete_backup(request.get('name'))
        return desktop_execute(controller,'snapshot',{})
    if action == 'backup-restore':
        name=request.get('name','')
        if not re.fullmatch(r'backup-[a-f0-9]{12}',name): raise ValueError('Invalid backup name')
        controller.restore(name)
        return desktop_execute(controller,'snapshot',{})
    if action == 'diagnostics':
        from .native import manager_values
        return doctor(controller,manager_values(controller)['PAWTALK_LANGUAGE'] if WINDOWS else controller.config()['PAWTALK_LANGUAGE'])
    if action == 'logs':
        file=controller.root/'var/log/pawtalk/server.log'
        if not file.exists(): return dict(text='')
        with file.open('rb') as stream:
            stream.seek(max(0,file.stat().st_size-65536)); text=stream.read().decode(errors='replace')
        text=re.sub(r'Initial room password[^\n]*','[redacted]',text)
        return dict(text=re.sub(r'pawtalk://\S+','[invitation redacted]',text))
    keys=json.loads((controller.etc/'trust.json').read_text())
    if action in ('check-updates','check-server-updates'): raise ValueError('Update checks require an unlocked network phase')
    if action == 'install-manager-update': return desktop_updates(controller,keys,install=True)
    if action == 'install-server-update':
        found=release.discover('server',keys)
        if found and release.semver(found['version'])>release.semver(controller.state()['version']): controller.update_server(found)
        save(controller.directory/'server-update.json',dict(status='current',checkedAt=int(time.time())))
        return desktop_execute(controller,'snapshot',{})
    raise ValueError('Unknown desktop operation')


def desktop_main(root,action):
    if not WINDOWS or not admin():
        print(json.dumps(dict(error='permission'))); return 1
    try:
        raw=sys.stdin.buffer.read(65537)
        if len(raw)>65536: raise ValueError('Request too large')
        request=json.loads(raw or b'{}')
        if not isinstance(request,dict): raise ValueError('Invalid request')
        protect(root)
        controller=Controller(root)
        if (not controller.state_file.exists() or (controller.directory/'setup.json').exists()) and action not in ('snapshot','apply','setup-server','inspect-server-package','logs','diagnostics'): raise ValueError('No installed room')
        if action in ('snapshot','logs','diagnostics'):
            # Atomic documents and read-only diagnostics do not need to wait for
            # a backup, service health probe or an installer holding the lock.
            value=desktop_execute(controller,action,request)
            print(json.dumps(dict(value=value),ensure_ascii=False)); return 0
        if action in ('check-updates','check-server-updates'):
            value=desktop_check(controller,'server' if action=='check-server-updates' else 'manager')
            print(json.dumps(dict(value=value),ensure_ascii=False)); return 0
        if action in ('install-manager-update','install-server-update'):
            component='server' if action=='install-server-update' else 'manager'
            value=desktop_check(controller,component,install=True,force=True)
            if component=='server': value=desktop_execute(controller,'snapshot',{})
            print(json.dumps(dict(value=value),ensure_ascii=False)); return 0
        with lock(controller.directory/'operation.lock',timeout=10):
            if (not controller.state_file.exists() or (controller.directory/'setup.json').exists()) and action not in ('apply','setup-server','inspect-server-package'): raise ValueError('No installed room')
            controller.recover()
            value=desktop_execute(controller,action,request)
        print(json.dumps(dict(value=value),ensure_ascii=False)); return 0
    except (OSError,ValueError,RuntimeError,KeyError) as error:
        message=str(error)
        code='noCompatibleServer' if 'No compatible published Server' in message else 'alreadyConfigured' if 'already configured' in message else 'portsOccupied' if 'ports are occupied' in message else 'conflict' if 'changed elsewhere' in message else 'busy' if 'lock' in message.lower() or 'operation is' in message.lower() else 'failed'
        print(json.dumps(dict(error=code))); return 1


def main(argv=None):
    args = arguments(argv)
    lang,source = args.lang or 'ru',Path(__file__).resolve().parent.parent
    if args.command == 'desktop':
        return desktop_main(args.root,args.action)
    if args.self_test:
        for module in bundles.MODULES:
            compile((source/'pawtalk_manager'/f'{module}.py').read_text(encoding='utf-8'),module,'exec')
        release.semver((source_file(source, 'VERSION')).read_text().strip())
        if not (source_file(source, 'compose.server.yaml')).is_file():
            return 1
        print('PawTalk manager protocol 1 OK')
        return 0
    try:
        if args.command == 'run-server':
            if not WINDOWS:
                raise ValueError('Windows service operation')
            from .native import serve
            return serve(args.root)
        if not admin():
            raise ValueError(text('tui_admin_windows',lang) if WINDOWS and args.command == 'tui' else 'Run with sudo/root')
        if WINDOWS:
            protect(args.root)
        controller = Controller(args.root)
        if args.command == 'tui':
            return tui_main(args,lang,controller)
        if args.command=='manager-install':
            if not WINDOWS: raise ValueError('Windows Manager operation')
            from .native import install_manager_only
            with lock(controller.directory/'operation.lock',timeout=10):
                install_manager_only(controller,source,lang)
                publish_desktop_status(controller)
            return 0
        if WINDOWS and args.command=='periodic':
            return windows_periodic(controller)
        if args.command == 'install' and args.server_bundle:
            if not WINDOWS:
                raise ValueError('--server-bundle is for Windows; Linux uses the signed image digest')
            controller.runtime.server_bundle = args.server_bundle
        # The freshly started maintenance service may briefly own this lock.
        # Let the interactive invitation request wait; watchdog/mutations remain
        # nonblocking so stopping maintenance from a foreground operation cannot deadlock.
        with lock(controller.directory/'operation.lock',timeout=10 if args.command in ('initial-admin','settings') else 0) as release_lock:
            if args.lang is None and controller.state_file.exists():
                lang = controller.config()['PAWTALK_LANGUAGE']
            if args.command == 'settings':
                if not controller.state_file.exists() or (args.apply and not WINDOWS):
                    raise ValueError('Settings unavailable')
                if WINDOWS:
                    controller.recover()
                if args.apply:
                    raw = sys.stdin.buffer.read(32769)
                    if len(raw) > 32768:
                        raise ValueError('Settings request too large')
                    changed = apply_settings(controller,json.loads(raw))
                else:
                    changed = False
                print(json.dumps(dict(values=controller.config(),changed=changed)))
                return 0
            if args.command in ('status','doctor'):
                print(json.dumps(doctor(controller,lang),ensure_ascii=False,indent=2))
                return 0
            if args.command == 'initial-admin':
                if not controller.state_file.exists():
                    raise ValueError('No installed server')
                result = controller.runtime.invitation(controller.state(),controller.config())
                if result is None:
                    print(text('invitation_unavailable',lang),file=sys.stderr)
                    return 2
                if args.url:
                    sys.stdout.write(result['url'])
                else:
                    print(json.dumps(result,ensure_ascii=False))
                return 0
            if args.command == 'install':
                existing = controller.state_file.exists()
                if args.new and existing:
                    raise ValueError(text('existing',lang))
                if existing:
                    directory = controller.root/'opt/pawtalk-manager/versions'/controller.state()['managerVersion']
                    bundles.self_test(directory)
                    if not WINDOWS and source.resolve() != (directory/'manager').resolve():
                        release_lock()
                        handoff([sys.executable,'-B','-X','utf8','-I',str(directory/'manager/pawtalkctl'),*(argv if argv is not None else sys.argv[1:])])
                    controller.install(controller.config(),{},source_file(source, 'compose.server.yaml'),'')
                else:
                    config = read_config(args.config) if args.config else wizard(lang,independent_updates=args.new) if sys.stdin.isatty() else None
                    if config is None:
                        raise ValueError('Noninteractive install requires --config')
                    if args.new and not args.config:
                        confirm(text('tui_setup_confirm',lang),False,lang)
                    bootstrap = args.bootstrap_docker
                    if not WINDOWS and not shutil.which('docker') and not bootstrap and sys.stdin.isatty():
                        confirm(text('docker',lang),False,lang)
                        bootstrap = True
                    preflight.check(config,bootstrap,args.no_systemd)
                    keys = json.loads(Path(args.trust or source/'trust.json').read_text())
                    server = manifest(args.server_manifest,'server',keys)
                    manager = manifest(args.manager_manifest,'manager',keys)
                    if server is None or manager is None:
                        raise ValueError('No compatible signed Server/Manager release')
                    directory = bundles.stage(controller.root,manager,keys,args.bundle)
                    if not WINDOWS and source.resolve() != (directory/'manager').resolve():
                        # Hand off to the verified Manager installer, not checkout code.
                        # Python descriptors are close-on-exec, releasing the operation lock.
                        prepared = controller.directory/'bootstrap'
                        write_config(prepared/'config.env',config)
                        save(prepared/'trust.json',keys)
                        atomic(prepared/'server-manifest.json',server['_signed'].encode())
                        atomic(prepared/'manager-manifest.json',manager['_signed'].encode())
                        command = [sys.executable,'-B','-X','utf8','-I',str(directory/'manager/pawtalkctl'),'--root',str(controller.root),'--lang',lang]
                        if args.no_systemd:
                            command.append('--no-systemd')
                        command += ['install','--config',str(prepared/'config.env'),'--trust',str(prepared/'trust.json'),
                                    '--server-manifest',str(prepared/'server-manifest.json'),'--manager-manifest',str(prepared/'manager-manifest.json'),
                                    '--bundle',str(directory/'verified-bundle.tar.gz')]
                        if args.server_bundle:
                            command += ['--server-bundle',str(Path(args.server_bundle).resolve())]
                        release_lock()
                        handoff(command)
                    if WINDOWS:
                        bundles.switch(controller.root,directory)
                    controller.install(config,server,directory/'manager/compose.server.yaml',manager['version'])
                config = controller.config()
                if not (controller.etc/'trust.json').exists():
                    atomic(controller.etc/'trust.json',(directory/'manager/trust.json').read_bytes())
                atomic(controller.root/'opt/pawtalk-manager/launcher',(directory/'manager/launcher').read_bytes(),0o700)
                atomic(controller.root/'usr/local/bin/pawtalkctl',b'#!/bin/sh\nexec /opt/pawtalk-manager/launcher "$@"\n',0o755)
                if not (controller.root/'opt/pawtalk-manager'/('current.json' if WINDOWS else 'current')).exists():
                    bundles.switch(controller.root,directory)
                bundles.install_units(controller.root,directory,config,args.no_systemd)
                state = controller.state()
                print(text('existing' if existing else 'installed',lang))
                if not existing:
                    invitation = controller.runtime.invitation(state,config)
                    if invitation:
                        print(text('invitation',lang))
                        print(invitation['url'])
                    else:
                        print(text('invitation_unavailable',lang))
                print(text('external',lang))
                return 0
            if args.command == 'backup' and args.action == 'list':
                if args.json:
                    print(json.dumps(backup_entries(controller.backups)))
                else:
                    print('\n'.join(p.name for p in sorted(controller.backups.glob('backup-*')) if p.is_dir()))
                return 0
            if args.command == 'backup' and args.action == 'restore':
                confirm(text('restore',lang)+'\n'+text('restore_freshness',lang),args.yes,lang)
                meta,_ = controller.snapshot(args.name or '')
                key_file = args.trust or (controller.etc/'trust.json' if (controller.etc/'trust.json').exists() else source/'trust.json')
                keys = json.loads(Path(key_file).read_text())
                release.verify_snapshot(meta,keys)
                directory = None
                if not controller.state_file.exists() and (not WINDOWS or 'managerSha256' in meta):
                    snapshot = controller.backups/args.name
                    manager = release.verify_historical((snapshot/'manager-manifest.json').read_bytes(),'manager',keys)
                    if manager['version'] != meta['state']['managerVersion']:
                        raise ValueError('Backup Manager version mismatch')
                    directory = bundles.stage(controller.root,manager,keys,snapshot/'manager.tar.gz')
                    if source.resolve() != (directory/'manager').resolve():
                        release_lock()
                        handoff([sys.executable,'-B','-X','utf8','-I',str(directory/'manager/pawtalkctl'),*(argv if argv is not None else sys.argv[1:])])
                if WINDOWS and directory is not None:
                    bundles.switch(controller.root,directory)
                controller.restore(args.name or '')
                if WINDOWS and directory is None:
                    from .native import installed_desktop_version
                    save(controller.state_file,{**controller.state(),'managerVersion':installed_desktop_version()})
                    for action in ['install-manager','start-manager']:
                        if host(action,controller.root).returncode: raise RuntimeError('Windows service setup failed')
                if directory is not None:
                    atomic(controller.etc/'trust.json',(directory/'manager/trust.json').read_bytes())
                    atomic(controller.root/'opt/pawtalk-manager/launcher',(directory/'manager/launcher').read_bytes(),0o700)
                    atomic(controller.root/'usr/local/bin/pawtalkctl',b'#!/bin/sh\nexec /opt/pawtalk-manager/launcher "$@"\n',0o755)
                    bundles.install_units(controller.root,directory,controller.config(),args.no_systemd)
                    bundles.switch(controller.root,directory)
                print(text('changed',lang))
                return 0
            if not controller.state_file.exists():
                raise ValueError('No installed room; run pawtalkctl install')
            if args.command == 'migration':
                if args.approval is not None and args.action != 'activate':
                    raise ValueError('--approval is only accepted for migration activate')
                if args.action == 'prepare':
                    confirm(text('migration_prepare',lang),args.yes,lang)
                    print(json.dumps(controller.prepare_protected_migration()))
                elif args.action == 'activate':
                    confirm(text('migration_activate',lang),args.yes,lang)
                    if args.approval is None:
                        result = controller.activate_protected_migration()
                    else:
                        with args.approval.open('rb') as approval:
                            result = controller.activate_protected_migration(approval=approval)
                    print(json.dumps(result))
                elif args.action == 'rollback':
                    confirm(text('migration_rollback',lang),args.yes,lang)
                    controller.rollback_protected_migration()
                    print(text('changed',lang))
                else:
                    print(json.dumps(controller.migration_status()))
                return 0
            controller.recover()
            config = controller.config()
            if args.command in ('start','stop'):
                if args.command == 'stop':
                    confirm(text('stop',lang),args.yes,lang)
                    controller.runtime.stop(controller.state(),config)
                else:
                    controller.runtime.start(controller.state(),config)
                print(text('changed',lang))
                return 0
            keys = json.loads((controller.etc/'trust.json').read_text())
            if args.command == 'periodic':
                if WINDOWS:
                    try:
                        desktop_updates(controller,keys,install=config['PAWTALK_MANAGER_AUTO_UPDATE']=='true')
                    except (OSError,ValueError,RuntimeError):
                        pass # A Manager network failure must not block independent Server maintenance.
                for component in ['manager','server']:
                    if WINDOWS and component == 'manager':
                        continue
                    if config[f'PAWTALK_{component.upper()}_AUTO_UPDATE'] != 'true':
                        continue
                    found = release.discover(component,keys)
                    if found:
                        if component == 'manager':
                            if bundles.activate(controller,found,keys,no_systemd=args.no_systemd):
                                return 0 # Next invocation uses the new controller.
                        else:
                            controller.update_server(found)
                return 0
            if args.command in ('update','manager'):
                component = 'server' if args.command == 'update' else 'manager'
                found = manifest(args.manifest,component,keys)
                if args.action == 'check' and args.details:
                    key = 'version' if component == 'server' else 'managerVersion'
                    state = controller.state()
                    current = state[key]
                    if WINDOWS and component == 'manager':
                        from .native import installed_desktop_version, manager_installer_field
                        current = installed_desktop_version()
                    available = bool(found and (not WINDOWS or found.get('windows' if component == 'server' else manager_installer_field())) and (
                        release.semver(found['version']) > release.semver(current) or
                        (WINDOWS and component == 'server' and state.get('localPackage') and
                         release.semver(found['version']) == release.semver(current))))
                    details = dict(available=available)
                    if available:
                        details.update(version=found['version'],manifest=found['_signed'],digest=found.get('digest'))
                    print(json.dumps(details))
                elif not found:
                    print(text('unchanged',lang))
                elif args.action == 'check':
                    print(json.dumps({component:found['version']}))
                else:
                    changed = controller.update_server(found) if component == 'server' else bundles.activate(controller,found,keys,args.bundle,args.no_systemd)
                    print(text('changed' if changed else 'unchanged',lang))
            elif args.command in ('configure','setup'):
                changes = {}
                for value in (args.values if args.command == 'configure' else []):
                    key,sep,val = value.partition('=')
                    if not sep or key in changes:
                        raise ValueError('Expected distinct PAWTALK_FIELD=value arguments')
                    changes[key] = val
                if args.command == 'setup':
                    changes = wizard(lang,config)
                confirm(text('confirm',lang),args.yes if args.command == 'configure' else False,lang)
                controller.configure(changes)
                current = (controller.root/'opt/pawtalk-manager/versions'/controller.state()['managerVersion']) if WINDOWS else controller.root/'opt/pawtalk-manager/current'
                bundles.install_units(controller.root,current.resolve(),controller.config(),args.no_systemd)
                print(text('changed',lang))
            elif args.command == 'backup' and args.action == 'delete':
                name = args.name or ''
                if not re.fullmatch(r'backup-[a-f0-9]{12}',name):
                    raise ValueError('Invalid backup name')
                confirm(text('tui_delete_confirm',lang).format(name=name),args.yes,lang)
                controller.delete_backup(name)
                print(text('changed',lang))
            elif args.command == 'backup':
                print(controller.create_backup())
            elif args.command == 'health':
                print(controller.watchdog())
            elif args.command == 'logs':
                if WINDOWS:
                    file = controller.root/'var/log/pawtalk/server.log'
                    with file.open('rb') as stream:
                        stream.seek(max(0,file.stat().st_size-65536))
                        output = stream.read().decode(errors='replace')
                else:
                    container = controller.runtime.container(controller.state(),config)['Id']
                    result = subprocess.run(['docker','logs','--tail','100',container],capture_output=True)
                    output = (result.stdout+result.stderr).decode(errors='replace')
                output = re.sub(r'Initial room password[^\n]*','Initial room password: [redacted]',output)
                print(re.sub(r'pawtalk://\S+','[invitation redacted]',output))
            elif args.command == 'uninstall':
                confirm(text('uninstall',lang),args.yes,lang)
                controller.runtime.stop(controller.state(),config)
                if WINDOWS:
                    # Stopping Manager from within its own periodic child would deadlock;
                    # uninstall is an explicit foreground operation.
                    for action in ['stop-manager','uninstall-manager','uninstall-server']:
                        if host(action,controller.root).returncode:
                            raise RuntimeError('Windows service removal failed')
                else:
                    controller.runtime.compose(controller.state(),config,'down')
                if not WINDOWS and not args.no_systemd:
                    run(['systemctl','disable','--now','pawtalk-update.timer','pawtalk-health.timer'])
                print(text('changed',lang))
        return 0
    except (OSError,ValueError,RuntimeError,KeyError,subprocess.SubprocessError) as error:
        if 'controller' in locals():
            with contextlib.suppress(OSError):
                # Never persist exception text: input/config/HTTP errors can contain secrets.
                save(controller.directory/'last-error.json',dict(command=args.command,category='validation' if isinstance(error,ValueError) else 'execution',at=int(time.time())))
        detail = text('download_error',lang).format(host=error.host,attempts=error.attempts) if isinstance(error,release.DownloadError) else str(error)
        print(text('error',lang)+' '+detail,file=sys.stderr)
        return 1
