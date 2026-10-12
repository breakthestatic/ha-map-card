import commonjs from '@rollup/plugin-commonjs';
import { nodeResolve } from '@rollup/plugin-node-resolve';

export default {
  input: 'src/index.js',
  output: {
    file: 'dist/map-card.js',
    format: 'cjs',
    // The card ships as a single file referenced directly by Home Assistant.
    // The MapLibre adapter is loaded via dynamic import() (so it stays out of
    // the module graph until the vector base layer is enabled); inline it so
    // the build still emits one chunk.
    inlineDynamicImports: true
  },
  plugins: [nodeResolve(), commonjs()]
};