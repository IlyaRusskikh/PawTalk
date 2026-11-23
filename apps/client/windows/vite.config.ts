import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const liveKitRoot = path.resolve(path.dirname(require.resolve('livekit-client')), '..');

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  plugins: [react()],
  resolve: {
    alias: [
      // The published LiveKit bundle is one large module. Its shipped sources can be split.
      { find: /^livekit-client$/, replacement: path.join(liveKitRoot, 'src/index.ts') },
      { find: /^events$/, replacement: require.resolve('events/', { paths: [liveKitRoot] }) },
    ],
  },
  server: {
    fs: { allow: [path.resolve(import.meta.dirname, '../../..')] },
    host: '127.0.0.1',
    strictPort: true,
    port: 5173,
    watch: { ignored: ['**/release/**'] },
  },
  build: {
    rolldownOptions: {
      output: {
        // Some renderer modules depend on each other across chunk boundaries.
        strictExecutionOrder: true,
        codeSplitting: {
          includeDependenciesRecursively: false,
          groups: [
            { name: 'react', test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/ },
            { name: 'voice-sdk', test: /node_modules[\\/]livekit-client[\\/]/ },
            { name: 'voice-protocol', test: /node_modules[\\/](?:@livekit|@bufbuild)[\\/]/ },
            { name: 'settings', test: /[\\/]src[\\/](?:MemberDialogs|MemberSettings|Protected[^\\/]*(?:Dialogs?|Settings))\.tsx$/ },
            { name: 'chat', test: /[\\/]src[\\/](?:ProtectedChat|ServerChat|Chat[A-Z][^\\/]*)\.tsx$/ },
            { name: 'translations', test: /[\\/]shared[\\/]en\.json$/ },
          ],
        },
      },
    },
  },
});
