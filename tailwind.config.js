/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        teal: {
          DEFAULT: '#0F9488',
        },
        canvas: '#FBFBFA',
        sidebar: '#F4F4F2',
        ink: '#15171C',
      },
      fontFamily: {
        sans: ['Inter Tight', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};
