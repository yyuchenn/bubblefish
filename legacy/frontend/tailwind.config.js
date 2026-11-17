/** @type {import('tailwindcss').Config} */
export default {
  theme: {
    extend: {
      colors: {
        primary: 'var(--color-primary)',
        secondary: 'var(--color-secondary)',
        'primary/10': 'rgba(var(--color-primary-rgb), 0.1)',
        'secondary/10': 'rgba(var(--color-secondary-rgb), 0.1)'
      },
      cursor: {
        crosshair: 'crosshair',
        'nw-resize': 'nw-resize',
        'ne-resize': 'ne-resize',
        'sw-resize': 'sw-resize',
        'se-resize': 'se-resize',
        'n-resize': 'n-resize',
        's-resize': 's-resize',
        'w-resize': 'w-resize',
        'e-resize': 'e-resize'
      }
    }
  },
  plugins: [
    '@tailwindcss/forms',
    '@tailwindcss/typography'
  ]
};
