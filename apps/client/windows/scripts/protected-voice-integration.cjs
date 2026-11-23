const { app, BrowserWindow } = require('electron');
const { readFileSync } = require('node:fs');

const { page, media, token, speaker, steps, profile } = JSON.parse(readFileSync(0, 'utf8'));
app.setPath('userData', profile);

async function verifyListener() {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await window.loadURL(page);
    await window.webContents.executeJavaScript(`(async () => {
      const room = new LivekitClient.Room();
      const endpoint = ${JSON.stringify(media)};
      const originalToken = ${JSON.stringify(token)};
      const canSpeak = ${JSON.stringify(speaker)};
      let source;
      let track;
      async function waitFor(predicate, message) {
        const deadline = performance.now() + 2500;
        while (performance.now() < deadline) {
          if (predicate()) return;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        throw new Error(message);
      }
      async function verifyPermissions(publish, subscribe) {
        await waitFor(() => {
          const permission = room.localParticipant.permissions;
          return permission?.canPublish === publish && permission?.canSubscribe === subscribe &&
            permission?.canPublishData === false;
        }, 'LiveKit did not apply publish=' + publish + ', subscribe=' + subscribe);
      }
      async function verifyOldGrantDenied() {
        const reconnect = new LivekitClient.Room();
        try {
          await reconnect.connect(endpoint, originalToken, { maxRetries: 0, websocketTimeout: 2500 });
        } catch (failure) {
          if (failure.status === 403) return;
          throw failure;
        } finally {
          await reconnect.disconnect();
        }
        throw new Error('PawTalk accepted the previous voice grant');
      }
      async function publishFixtureTrack() {
        source = new AudioContext();
        const oscillator = source.createOscillator();
        const output = source.createMediaStreamDestination();
        oscillator.connect(output);
        oscillator.start();
        await source.resume();
        [track] = output.stream.getAudioTracks();
        await room.localParticipant.publishTrack(track, { source: LivekitClient.Track.Source.Microphone });
      }
      try {
        await room.connect(endpoint, originalToken, { autoSubscribe: true });
        await verifyPermissions(canSpeak, true);
        if (canSpeak) {
          await publishFixtureTrack();
        } else {
          let denied = false;
          try {
            await publishFixtureTrack();
          } catch (failure) {
            if (failure.name !== 'PublishTrackError' || failure.status !== 403 ||
                !track?.enabled || track.readyState !== 'live') throw failure;
            denied = true;
          }
          if (!denied || room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone)) {
            throw new Error('A listen-only participant published the fixture microphone');
          }
        }
        const voiceSteps = ${JSON.stringify(steps ?? [])};
        for (let index = 0; index < voiceSteps.length; index++) {
          const response = await fetch('/change?step=' + index, { method: 'POST' });
          if (!response.ok) throw new Error(await response.text());
          const { publish, subscribe, disconnect } = voiceSteps[index];
          if (disconnect) {
            await waitFor(() => room.state === LivekitClient.ConnectionState.Disconnected,
              'LiveKit did not disconnect the previous room');
          } else {
            await verifyPermissions(publish, subscribe);
            if (!publish) {
              await waitFor(() => !room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone),
                'LiveKit kept the published microphone after removing Speak');
            }
          }
          await verifyOldGrantDenied();
        }
      } finally {
        await room.disconnect();
        track?.stop();
        await source?.close();
      }
    })()`);
    console.log('PASS protected LiveKit voice permissions');
  } finally {
    window.destroy();
  }
}

app.whenReady().then(verifyListener).then(() => app.exit(0), error => {
  console.error(error);
  app.exit(1);
});
