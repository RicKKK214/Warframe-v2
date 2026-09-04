import type { Config } from 'tailwindcss';
const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        void: '#05060a',
        panel: '#0d1018',
        panel2: '#131826',
        edge: '#1f2637',
        accent: '#8b5cf6',
        accent2: '#a78bfa',
        profit: '#22c55e',
        loss: '#ef4444',
        plat: '#c9d6ff',
      },
      fontFamily: { mono: ['ui-monospace', 'SFMono-Regular', 'monospace'] },
    },
  },
  plugins: [],
};
export default config;
