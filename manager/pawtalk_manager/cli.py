"""Interactive host CLI; disabled automatic updates perform no network requests."""
import argparse
import contextlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from . import bundles, preflight, release
from .config import DEFAULTS, atomic, lock, read_config, write_config, save, validate
from .controller import Controller
from .runtime import run
from .platforms import WINDOWS, admin, default_root, host, protect

MESSAGES = {
 'confirm':('Продолжить? [y/N]: ','Continue? [y/N]: '),
 'ip':('Подтвердите публичный IPv4','Confirm public IPv4'),
 'port':('Основной порт','Base port'),
 'e2ee':('Включить сквозное шифрование? (да/нет)','Enable end-to-end encryption? (yes/no)'),
 'key':('SHA-256 key ID из клиента (НЕ секретный ключ)','SHA-256 key ID from Client (NOT the secret key)'),
 'chat':('Лимит истории, МиБ (0 = без ограничения)','History limit, MiB (0 = unlimited)'),
 'auto':('Включить автоматическое обновление сервера? (да/нет)','Enable automatic server updates? (yes/no)'),
 'updates':('Обновление сервера прерывает звонок. Автообновление включает сервер и средство его обслуживания.','Server updates interrupt calls. Automatic updates include the server and its maintenance tool.'),
 'docker':('Установить Docker из официального apt-репозитория?','Install Docker from its official apt repository?'),
 'installed':('Комната установлена. Сохраните приглашение и первый пароль.','Room installed. Save the invitation and initial password.'),
 'invitation':('Приглашение (вставьте только следующую строку в клиент):','Invitation (paste only the next line into the client):'),
 'initial_password':('Первый пароль (введите в отдельном окне пароля клиента):','Initial password (enter in the client’s separate password dialog):'),
 'password_unavailable':('Старый пароль не сохранён. В меню сервера выберите «Сменить пароль и скопировать приглашение». Смена пароля прервёт текущие звонки.', 'The old password was not saved. Choose “Reset password and copy invitation” in the server menu. Resetting the password interrupts current calls.'),
 'reset_password':('Сменить пароль комнаты и перезапустить сервер? Старые приглашения с паролем перестанут работать.', 'Reset the room password and restart the server? Old password-bearing invitations will stop working.'),
 'existing':('Существующая комната сохранена; данные не сброшены.','Existing room preserved; data retained.'),
 'external':('Локальная проверка не подтверждает внешний TCP/UDP и голос из другой сети.','Local checks do not verify external TCP/UDP or voice from another network.'),
 'error':('Ошибка выполнения.','Operation failed.'),
 'download_error':('Не удалось скачать файлы с {host} после {attempts} попыток. Проверьте доступ к GitHub через вашу сеть/VPN и повторите установку.', 'Could not download files from {host} after {attempts} attempts. Check GitHub access through your network/VPN and retry installation.'),
 'changed':('Изменения применены.','Changes applied.'),
 'unchanged':('Изменений нет.','No changes.'),
 'restore':('Восстановить копию? Работающая комната будет остановлена.','Restore backup? The running room will stop.'),
 'uninstall':('Остановить комнату и таймеры? Данные и настройки сохранятся.','Stop room and timers? Data and settings will be kept.'),
 'healthy':('Работает','Healthy'),'unhealthy':('Ошибка проверки здоровья','Unhealthy'),
 'starting':('Запускается','Starting'),'unknown':('Состояние неизвестно','Unknown state'),
 'invalid_bool':('Введите да или нет (также принимаются yes/no и true/false).','Enter yes or no (true/false also accepted).'),
 'invalid_ip':('Введите корректный IPv4-адрес.','Enter a valid IPv4 address.'),
 'invalid_port':('Введите порт от 1024 до 65532.','Enter a port from 1024 to 65532.'),
 'invalid_key':('Введите SHA-256 key ID: 64 шестнадцатеричных символа.','Enter the SHA-256 key ID: 64 hexadecimal characters.'),
 'invalid_chat':('Введите целое число от 0 до 1048576 МиБ.','Enter an integer from 0 to 1048576 MiB.'),
}


def text(key,lang):
    return MESSAGES[key][lang == 'en']


SETTINGS_FIELDS = {'PAWTALK_PUBLIC_IP','PAWTALK_PORT','PAWTALK_E2EE','PAWTALK_E2EE_KEY_ID',
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


def wizard(lang,initial=None):
    values = dict(DEFAULTS,**(initial or {}))
    values['PAWTALK_LANGUAGE'] = lang
    candidates = [] if initial else preflight.public_candidates()
    fields = [('ip','PAWTALK_PUBLIC_IP'),('port','PAWTALK_PORT'),('e2ee','PAWTALK_E2EE'),
              ('key','PAWTALK_E2EE_KEY_ID'),('chat','PAWTALK_CHAT_MAX_MB'),('auto','PAWTALK_SERVER_AUTO_UPDATE')]
    values['PAWTALK_PUBLIC_IP'] = values.get('PAWTALK_PUBLIC_IP',candidates[0] if candidates else '')
    print(text('updates',lang))
    for key,field in fields:
        if key == 'key' and values['PAWTALK_E2EE'] != 'true':
            continue
        default = 'true' if not initial and key in ('e2ee','auto') else values[field]
        boolean = key in ('e2ee','auto')
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
                if key == 'key':
                    response = response.lower()
                try:
                    validate({**values,field:response})
                except ValueError:
                    print(text('invalid_'+key,lang))
                    continue
            values[field] = response
            if key == 'auto':
                values['PAWTALK_MANAGER_AUTO_UPDATE'] = response
            break
    return validate(values)


def manifest(file,component,keys):
    found = release.verify(Path(file).read_bytes(),component,keys) if file else release.discover(component,keys)
    return found


def doctor(controller,lang):
    result = dict(installed=controller.state_file.exists(),transactionPending=controller.journal.exists(),
                  freeMiB=shutil.disk_usage(controller.root).free//1048576,externalNetworkVerified=False)
    if not result['installed']:
        result['action'] = 'pawtalkctl install / pawtalkctl backup restore'
        return result
    state,config = controller.state(),controller.config()
    result.update(serverVersion=state['version'],managerVersion=state['managerVersion'],image=state['image'])
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
    invitation = sub.add_parser('invitation')
    invitation.add_argument('--url',action='store_true')
    invitation.add_argument('--reset-password',action='store_true')
    invitation.add_argument('--yes',action='store_true')
    for name in ['status','doctor','logs','periodic','health','run-server','setup']:
        sub.add_parser(name)
    settings = sub.add_parser('settings')
    settings.add_argument('--apply',action='store_true')
    config = sub.add_parser('configure')
    config.add_argument('values',nargs='+',help='PAWTALK_FIELD=value')
    config.add_argument('--yes',action='store_true')
    for name in ['update','manager']:
        update = sub.add_parser(name)
        update.add_argument('action',choices=['check','now'])
        update.add_argument('--manifest')
        if name == 'manager':
            update.add_argument('--bundle')
    backup = sub.add_parser('backup')
    backup.add_argument('action',choices=['create','list','restore'])
    backup.add_argument('name',nargs='?')
    backup.add_argument('--yes',action='store_true')
    backup.add_argument('--trust')
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


def main(argv=None):
    args = arguments(argv)
    lang,source = args.lang or 'ru',Path(__file__).resolve().parent.parent
    if args.self_test:
        for module in bundles.MODULES:
            compile((source/'pawtalk_manager'/f'{module}.py').read_text(encoding='utf-8'),module,'exec')
        release.semver((source/'VERSION').read_text().strip())
        if not (source/'compose.server.yaml').is_file():
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
            raise ValueError('Run with sudo/root')
        if WINDOWS:
            protect(args.root)
        controller = Controller(args.root)
        if args.command == 'install' and args.server_bundle:
            if not WINDOWS:
                raise ValueError('--server-bundle is for Windows; Linux uses the signed image digest')
            controller.runtime.server_bundle = args.server_bundle
        # The freshly started maintenance service may briefly own this lock.
        # Let the interactive invitation request wait; watchdog/mutations remain
        # nonblocking so stopping maintenance from a foreground operation cannot deadlock.
        with lock(controller.directory/'operation.lock',timeout=10 if args.command in ('invitation','settings') else 0) as release_lock:
            if args.lang is None and controller.state_file.exists():
                lang = controller.config()['PAWTALK_LANGUAGE']
            if args.command == 'settings':
                if not WINDOWS or not controller.state_file.exists():
                    raise ValueError('No installed Windows room')
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
            if args.command == 'invitation':
                if not WINDOWS or not controller.state_file.exists():
                    raise ValueError('No installed Windows room')
                if args.reset_password:
                    confirm(text('reset_password',lang),args.yes,lang)
                result = controller.runtime.invitation(controller.state(),controller.config(),reset=args.reset_password)
                if result is None:
                    print(text('password_unavailable',lang),file=sys.stderr)
                    return 2
                if args.url:
                    sys.stdout.write(result['url'])
                else:
                    print(json.dumps(result,ensure_ascii=False))
                return 0
            if args.command == 'install':
                existing = controller.state_file.exists()
                if existing:
                    directory = controller.root/'opt/pawtalk-manager/versions'/controller.state()['managerVersion']
                    bundles.self_test(directory)
                    if not WINDOWS and source.resolve() != (directory/'manager').resolve():
                        release_lock()
                        handoff([sys.executable,'-B','-X','utf8','-I',str(directory/'manager/pawtalkctl'),*(argv if argv is not None else sys.argv[1:])])
                    controller.install(controller.config(),{},source/'compose.server.yaml','')
                else:
                    config = read_config(args.config) if args.config else wizard(lang) if sys.stdin.isatty() else None
                    if config is None:
                        raise ValueError('Noninteractive install requires --config')
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
                container = controller.runtime.container(state,config)['Id']
                print(text('existing' if existing else 'installed',lang))
                if WINDOWS:
                    invitation = controller.runtime.invitation(state,config)
                    if invitation:
                        print(text('invitation',lang))
                        print(invitation['url'])
                    else:
                        print(text('password_unavailable',lang))
                elif not existing:
                    for action in ['info','initial-password']:
                        print(text('invitation' if action == 'info' else 'initial_password',lang))
                        print((controller.runtime.command(state,config,action) if WINDOWS else run(['docker','exec',container,'/pawtalk','serve',action])).decode().strip())
                print(text('external',lang))
                return 0
            if args.command == 'backup' and args.action == 'list':
                print('\n'.join(p.name for p in sorted(controller.backups.glob('backup-*')) if p.is_dir()))
                return 0
            if args.command == 'backup' and args.action == 'restore':
                confirm(text('restore',lang),args.yes,lang)
                meta,_ = controller.snapshot(args.name or '')
                key_file = args.trust or (controller.etc/'trust.json' if (controller.etc/'trust.json').exists() else source/'trust.json')
                keys = json.loads(Path(key_file).read_text())
                release.verify_snapshot(meta,keys)
                directory = None
                if not controller.state_file.exists():
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
            controller.recover()
            config = controller.config()
            keys = json.loads((controller.etc/'trust.json').read_text())
            if args.command == 'periodic':
                for component in ['manager','server']:
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
                if not found:
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
