/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        bg: '#0f1115',
        panel: '#161922',
        border: '#262b38',
        ink: '#e6e8ee',
        muted: '#8c93a6',
        accent: '#7dd3fc',
        good: '#4ade80',
        warn: '#fbbf24',
        bad: '#f87171',
      },
    },
  },
  plugins: [],
};
