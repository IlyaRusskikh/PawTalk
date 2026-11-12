import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
export default defineConfig({root:import.meta.dirname,base:'./',plugins:[react()],build:{outDir:'dist',emptyOutDir:true},server:{host:'127.0.0.1',fs:{allow:[path.resolve(import.meta.dirname,'../..')]}}});
