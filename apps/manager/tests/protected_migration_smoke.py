"""Run the signed migration against the platform's real Manager runtime."""
import hashlib
import io
import json
import tempfile

from pawtalk_manager.controller import Controller


def activate_and_verify(controller, prepared, client):
    installed, config = controller.state(), controller.config()
    archive_sha = prepared['checkpoint']['backupArchiveSha256']
    _, original = controller.snapshot(prepared['backup'])
    assert hashlib.sha256(original.read_bytes()).hexdigest() == archive_sha

    def migration_command(action, payload=None):
        if payload is None:
            output = controller.runtime.migration_command(installed,config,action,archive_sha)
        else:
            with tempfile.TemporaryFile() as stream:
                stream.write(json.dumps(payload).encode())
                stream.seek(0)
                output = controller.runtime.migration_command(installed,config,action,archive_sha,archive=stream)
        return json.loads(output)

    assert client('import')['confirmedPackages'] > 0
    review = migration_command('migration-verify')
    migration_command('migration-approve-import',client('review',report=review))
    client('recipient',report=review)
    policy = client('policy',report=migration_command('migration-verify'))
    migration_command('migration-stage-policy',policy)
    client('keys',policyApproval=policy)
    approval = client('approve',report=migration_command('migration-verify'),policyApproval=policy)
    active = controller.activate_protected_migration(io.BytesIO(json.dumps(approval).encode()))
    assert active['activation']['cutoverDigest'] == approval['cutoverDigest']
    assert active['phase'] == 'migration-active' and active['backup'] == prepared['backup']
    assert client('verify',cutoverDigest=approval['cutoverDigest']) is True

    controller.runtime.stop(controller.state(),config)
    restarted = Controller(controller.root)
    restarted.runtime.start(restarted.state(),config)
    assert restarted.runtime.healthy(restarted.state(),config,installed['identity']) == installed['identity']
    assert client('verify',cutoverDigest=approval['cutoverDigest']) is True
    try:
        restarted.restore(prepared['backup'])
        raise AssertionError('Pre-cutover API 2 restore replaced the active protected room')
    except ValueError as error:
        assert str(error) == 'Cannot restore an API 2 backup over an active protected room'
    assert restarted.migration_status() == active
    assert hashlib.sha256(original.read_bytes()).hexdigest() == archive_sha
