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
from .config import DEFAULTS, atomic, lock, read_config, write_config, save
from .controller import Controller
from .runtime import run

MESSAGES = {
 'confirm':('Продолжить? [y/N]: ','Continue? [y/N]: '),
 'ip':('Подтвердите публичный IPv4','Confirm public IPv4'),
 'port':('Основной порт','Base port'),
 'e2ee':('Требовать E2EE? (true/false)','Require E2EE? (true/false)'),
 'key':('SHA-256 key ID из клиента (НЕ секретный ключ)','SHA-256 key ID from Client (NOT the secret key)'),
 'chat':('Лимит истории, МиБ (0 = без ограничения)','History limit, MiB (0 = unlimited)'),
 'server_auto':('Автообновление Server? (true/false)','Server auto-updates? (true/false)'),
 'deploy_auto':('Автообновление Deploy? (true/false)','Deploy auto-updates? (true/false)'),
 'server_channel':('Канал Server (stable/preview)','Server channel (stable/preview)'),
 'deploy_channel':('Канал Deploy (stable/preview)','Deploy channel (stable/preview)'),
 'preview':('preview содержит предварительные выпуски. Обновление Server прерывает звонок.','preview includes prereleases. Server updates interrupt calls.'),
 'docker':('Установить Docker из официального apt-репозитория?','Install Docker from its official apt repository?'),
 'installed':('Комната установлена. Сохраните приглашение и первый пароль.','Room installed. Save the invitation and initial password.'),
 'existing':('Существующая комната сохранена; данные не сброшены.','Existing room preserved; data retained.'),
 'external':('Локальная проверка не подтверждает внешний TCP/UDP и голос из другой сети.','Local checks do not verify external TCP/UDP or voice from another network.'),
 'error':('Ошибка выполнения.','Operation failed.'),
 'changed':('Изменения применены.','Changes applied.'),
 'unchanged':('Изменений нет.','No changes.'),
 'restore':('Восстановить копию? Работающая комната будет остановлена.','Restore backup? The running room will stop.'),
 'uninstall':('Остановить комнату и таймеры? Данные и настройки сохранятся.','Stop room and timers? Data and settings will be kept.'),
 'healthy':('Работает','Healthy'),'unhealthy':('Ошибка проверки здоровья','Unhealthy'),
 'starting':('Запускается','Starting'),'unknown':('Состояние неизвестно','Unknown state'),
}


def text(key,lang):
    return MESSAGES[key][lang == 'en']


def confirm(message,yes,lang):
    if yes:
        return
    if not sys.stdin.isatty():
        raise ValueError('Explicit --yes confirmation required in noninteractive mode')
    print(message)
    if input(text('confirm',lang)).strip().lower() not in ('y','yes','да'):
        raise ValueError('Cancelled')


def wizard(lang):
    values = dict(DEFAULTS,PAWTALK_LANGUAGE=lang)
    candidates = preflight.public_candidates()
    fields = [('ip','PAWTALK_PUBLIC_IP'),('port','PAWTALK_PORT'),('e2ee','PAWTALK_E2EE'),
              ('key','PAWTALK_E2EE_KEY_ID'),('chat','PAWTALK_CHAT_MAX_MB'),('server_auto','PAWTALK_SERVER_AUTO_UPDATE'),
              ('deploy_auto','PAWTALK_DEPLOY_AUTO_UPDATE'),('server_channel','PAWTALK_SERVER_CHANNEL'),('deploy_channel','PAWTALK_DEPLOY_CHANNEL')]
    values['PAWTALK_PUBLIC_IP'] = candidates[0] if candidates else ''
    print(text('preview',lang))
    for key,field in fields:
        if key == 'key' and values['PAWTALK_E2EE'] != 'true':
            continue
        default = values[field]
        values[field] = input(text(key,lang)+(f' [{default}]' if default else '')+': ').strip() or default
    from .config import validate
    return validate(values)


def manifest(file,component,channel,keys):
    found = release.verify(Path(file).read_bytes(),component,keys) if file else release.discover(component,channel,keys)
    if found and channel == 'stable' and found['channel'] != 'stable':
        raise ValueError('Preview manifest rejected by stable channel')
    return found


def doctor(controller,lang):
    result = dict(installed=controller.state_file.exists(),transactionPending=controller.journal.exists(),
                  freeMiB=shutil.disk_usage(controller.root).free//1048576,externalNetworkVerified=False)
    if not result['installed']:
        result['action'] = 'pawtalkctl install / pawtalkctl backup restore'
        return result
    state,config = controller.state(),controller.config()
    result.update(serverVersion=state['version'],deployVersion=state['deployVersion'],image=state['image'])
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
    for name in ['pawtalk-update.timer','pawtalk-health.timer']:
        if shutil.which('systemctl'):
            result[name] = subprocess.run(['systemctl','is-active','--quiet',name],capture_output=True).returncode == 0
    return result


def arguments(argv):
    p = argparse.ArgumentParser(description='PawTalk VPS CLI / Управление VPS')
    p.add_argument('--root',default='/')
    p.add_argument('--lang',choices=['ru','en'])
    p.add_argument('--no-systemd',action='store_true',help='Container/local verification only')
    p.add_argument('--self-test',action='store_true')
    sub = p.add_subparsers(dest='command')
    install = sub.add_parser('install')
    for key in ['config','trust','server-manifest','deploy-manifest','bundle']:
        install.add_argument('--'+key)
    install.add_argument('--bootstrap-docker',action='store_true')
    for name in ['status','doctor','logs','periodic','health']:
        sub.add_parser(name)
    config = sub.add_parser('configure')
    config.add_argument('values',nargs='+',help='PAWTALK_FIELD=value')
    config.add_argument('--yes',action='store_true')
    for name in ['update','deploy']:
        update = sub.add_parser(name)
        update.add_argument('action',choices=['check','now'])
        update.add_argument('--manifest')
        if name == 'deploy':
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


def main(argv=None):
    args = arguments(argv)
    lang,source = args.lang or 'ru',Path(__file__).resolve().parent.parent
    if args.self_test:
        for module in bundles.MODULES:
            compile((source/'pawtalk_agent'/f'{module}.py').read_text(),module,'exec')
        release.semver((source/'VERSION').read_text().strip())
        if not (source/'compose.server.yaml').is_file():
            return 1
        print('PawTalk deploy protocol 1 OK')
        return 0
    try:
        if os.geteuid() != 0:
            raise ValueError('Run with sudo/root')
        controller = Controller(args.root)
        with lock(controller.directory/'operation.lock'):
            if args.lang is None and controller.state_file.exists():
                lang = controller.config()['PAWTALK_LANGUAGE']
            if args.command in ('status','doctor'):
                print(json.dumps(doctor(controller,lang),ensure_ascii=False,indent=2))
                return 0
            if args.command == 'install':
                existing = controller.state_file.exists()
                if existing:
                    directory = controller.root/'opt/pawtalk-agent/versions'/controller.state()['deployVersion']
                    bundles.self_test(directory)
                    if source.resolve() != (directory/'deploy').resolve():
                        os.execv(sys.executable,[sys.executable,'-I',str(directory/'deploy/pawtalkctl'),*(argv if argv is not None else sys.argv[1:])])
                    controller.install(controller.config(),{},source/'compose.server.yaml','')
                else:
                    config = read_config(args.config) if args.config else wizard(lang) if sys.stdin.isatty() else None
                    if config is None:
                        raise ValueError('Noninteractive install requires --config')
                    bootstrap = args.bootstrap_docker
                    if not shutil.which('docker') and not bootstrap and sys.stdin.isatty():
                        confirm(text('docker',lang),False,lang)
                        bootstrap = True
                    preflight.check(config,bootstrap,args.no_systemd)
                    keys = json.loads(Path(args.trust or source/'trust.json').read_text())
                    server = manifest(args.server_manifest,'server',config['PAWTALK_SERVER_CHANNEL'],keys)
                    deploy = manifest(args.deploy_manifest,'deploy',config['PAWTALK_DEPLOY_CHANNEL'],keys)
                    if server is None or deploy is None:
                        raise ValueError('No compatible signed Server/Deploy release')
                    directory = bundles.stage(controller.root,deploy,keys,args.bundle)
                    if source.resolve() != (directory/'deploy').resolve():
                        # Hand off to the verified Deploy installer, not checkout code.
                        # Python descriptors are close-on-exec, releasing the operation lock.
                        prepared = controller.directory/'bootstrap'
                        write_config(prepared/'config.env',config)
                        save(prepared/'trust.json',keys)
                        atomic(prepared/'server-manifest.json',server['_signed'].encode())
                        atomic(prepared/'deploy-manifest.json',deploy['_signed'].encode())
                        command = [sys.executable,'-I',str(directory/'deploy/pawtalkctl'),'--root',str(controller.root),'--lang',lang]
                        if args.no_systemd:
                            command.append('--no-systemd')
                        command += ['install','--config',str(prepared/'config.env'),'--trust',str(prepared/'trust.json'),
                                    '--server-manifest',str(prepared/'server-manifest.json'),'--deploy-manifest',str(prepared/'deploy-manifest.json'),
                                    '--bundle',str(directory/'verified-bundle.tar.gz')]
                        os.execv(sys.executable,command)
                    controller.install(config,server,directory/'deploy/compose.server.yaml',deploy['version'])
                config = controller.config()
                if not (controller.etc/'trust.json').exists():
                    atomic(controller.etc/'trust.json',(directory/'deploy/trust.json').read_bytes())
                atomic(controller.root/'opt/pawtalk-agent/launcher',(directory/'deploy/launcher').read_bytes(),0o700)
                atomic(controller.root/'usr/local/bin/pawtalkctl',b'#!/bin/sh\nexec /opt/pawtalk-agent/launcher "$@"\n',0o755)
                bundles.install_units(controller.root,directory,config,args.no_systemd)
                if not (controller.root/'opt/pawtalk-agent/current').is_symlink():
                    bundles.switch(controller.root,directory)
                state = controller.state()
                container = controller.runtime.container(state,config)['Id']
                print(text('existing' if existing else 'installed',lang))
                if not existing:
                    print(run(['docker','exec',container,'/pawtalk','serve','info']).decode().strip())
                    print(run(['docker','exec',container,'/pawtalk','serve','initial-password']).decode().strip())
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
                    deploy = release.verify_historical((snapshot/'deploy-manifest.json').read_bytes(),'deploy',keys)
                    if deploy['version'] != meta['state']['deployVersion']:
                        raise ValueError('Backup Deploy version mismatch')
                    directory = bundles.stage(controller.root,deploy,keys,snapshot/'deploy.tar.gz')
                    if source.resolve() != (directory/'deploy').resolve():
                        os.execv(sys.executable,[sys.executable,'-I',str(directory/'deploy/pawtalkctl'),*(argv if argv is not None else sys.argv[1:])])
                controller.restore(args.name or '')
                if directory is not None:
                    atomic(controller.etc/'trust.json',(directory/'deploy/trust.json').read_bytes())
                    atomic(controller.root/'opt/pawtalk-agent/launcher',(directory/'deploy/launcher').read_bytes(),0o700)
                    atomic(controller.root/'usr/local/bin/pawtalkctl',b'#!/bin/sh\nexec /opt/pawtalk-agent/launcher "$@"\n',0o755)
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
                for component in ['deploy','server']:
                    if config[f'PAWTALK_{component.upper()}_AUTO_UPDATE'] != 'true':
                        continue
                    found = release.discover(component,config[f'PAWTALK_{component.upper()}_CHANNEL'],keys)
                    if found:
                        if component == 'deploy':
                            if bundles.activate(controller,found,keys,no_systemd=args.no_systemd):
                                return 0 # Next invocation uses the new controller.
                        else:
                            controller.update_server(found)
                return 0
            if args.command in ('update','deploy'):
                component = 'server' if args.command == 'update' else 'deploy'
                found = manifest(args.manifest,component,config[f'PAWTALK_{component.upper()}_CHANNEL'],keys)
                if not found:
                    print(text('unchanged',lang))
                elif args.action == 'check':
                    print(json.dumps({component:found['version'],'channel':found['channel']}))
                else:
                    changed = controller.update_server(found) if component == 'server' else bundles.activate(controller,found,keys,args.bundle,args.no_systemd)
                    print(text('changed' if changed else 'unchanged',lang))
            elif args.command == 'configure':
                changes = {}
                for value in args.values:
                    key,sep,val = value.partition('=')
                    if not sep or key in changes:
                        raise ValueError('Expected distinct PAWTALK_FIELD=value arguments')
                    changes[key] = val
                confirm(text('confirm',lang),args.yes,lang)
                controller.configure(changes)
                current = controller.root/'opt/pawtalk-agent/current'
                bundles.install_units(controller.root,current.resolve(),controller.config(),args.no_systemd)
                print(text('changed',lang))
            elif args.command == 'backup':
                print(controller.create_backup())
            elif args.command == 'health':
                print(controller.watchdog())
            elif args.command == 'logs':
                container = controller.runtime.container(controller.state(),config)['Id']
                result = subprocess.run(['docker','logs','--tail','100',container],capture_output=True)
                output = (result.stdout+result.stderr).decode(errors='replace')
                output = re.sub(r'Initial room password[^\n]*','Initial room password: [redacted]',output)
                print(re.sub(r'pawtalk://\S+','[invitation redacted]',output))
            elif args.command == 'uninstall':
                confirm(text('uninstall',lang),args.yes,lang)
                controller.runtime.stop(controller.state(),config)
                controller.runtime.compose(controller.state(),config,'down')
                if not args.no_systemd:
                    run(['systemctl','disable','--now','pawtalk-update.timer','pawtalk-health.timer'])
                print(text('changed',lang))
        return 0
    except (OSError,ValueError,RuntimeError,KeyError,subprocess.SubprocessError) as error:
        if 'controller' in locals():
            with contextlib.suppress(OSError):
                # Never persist exception text: input/config/HTTP errors can contain secrets.
                save(controller.directory/'last-error.json',dict(command=args.command,category='validation' if isinstance(error,ValueError) else 'execution',at=int(time.time())))
        print(text('error',lang)+' '+str(error),file=sys.stderr)
        return 1
