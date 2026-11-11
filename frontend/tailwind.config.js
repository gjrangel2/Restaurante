/** @type {import('tailwindcss').Config} */
const withAlpha = (name) => `rgb(var(${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Instrument Sans Variable"', 'system-ui', 'sans-serif'],
        display: ['"Bricolage Grotesque Variable"', '"Instrument Sans Variable"', 'system-ui', 'sans-serif'],
      },
      colors: {
        // Interfaz del personal: neutros que cambian con el tema claro/oscuro
        // (valores en src/index.css). El color se reserva para el ESTADO.
        canvas: withAlpha('--canvas'),
        surface: withAlpha('--surface'),
        sunken: withAlpha('--sunken'),
        line: withAlpha('--line'),
        ink: {
          DEFAULT: withAlpha('--ink'),
          soft: withAlpha('--ink-soft'),
          faint: withAlpha('--ink-faint'),
        },
        series: withAlpha('--series'), // color de las barras del dashboard

        // Los 5 estados del mapa (ver features/floor/tableStatus.ts)
        state: {
          free: withAlpha('--state-free'),
          'free-ink': withAlpha('--state-free-ink'),
          occupied: '#2563EB',
          waiting: '#EA580C',
          served: '#16A34A',
          calling: '#DC2626',
        },

        // App del cliente: identidad del restaurante demo "Fogón"
        hoja: { DEFAULT: '#0C3B2E', 700: '#14523F', 100: '#DCE9E2' },
        maiz: { DEFAULT: '#FFC533', 600: '#E5A800' },
        guayaba: '#FF5D73',
        niebla: '#EEF3EF',
        tinta: { DEFAULT: '#14201B', soft: '#55635C' },
      },
      boxShadow: {
        lift: '0 1px 2px rgb(16 24 40 / 0.06), 0 8px 24px -6px rgb(16 24 40 / 0.14)',
        dock: '0 -1px 0 rgb(12 59 46 / 0.06), 0 -12px 32px -12px rgb(12 59 46 / 0.18)',
      },
      keyframes: {
        // Rojo parpadeante de "llamado / pide la cuenta"
        blink: { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0.45' } },
        ring: { '0%': { transform: 'scale(1)', opacity: '0.7' }, '100%': { transform: 'scale(1.35)', opacity: '0' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        'sheet-up': { from: { transform: 'translateY(100%)' }, to: { transform: 'translateY(0)' } },
        'slide-in': { from: { transform: 'translateX(100%)' }, to: { transform: 'translateX(0)' } },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'toast-in': { from: { opacity: '0', transform: 'translateY(-8px) scale(0.98)' }, to: { opacity: '1', transform: 'translateY(0) scale(1)' } },
        pop: { '0%': { transform: 'scale(1)' }, '40%': { transform: 'scale(1.25)' }, '100%': { transform: 'scale(1)' } },
      },
      animation: {
        blink: 'blink 1.1s ease-in-out infinite',
        ring: 'ring 1.4s ease-out infinite',
        shimmer: 'shimmer 1.4s infinite',
        'sheet-up': 'sheet-up 0.28s cubic-bezier(0.2, 0.8, 0.2, 1)',
        'slide-in': 'slide-in 0.25s cubic-bezier(0.2, 0.8, 0.2, 1)',
        'fade-in': 'fade-in 0.2s ease-out',
        'toast-in': 'toast-in 0.22s ease-out',
        pop: 'pop 0.3s ease-out',
      },
    },
  },
  plugins: [],
};
