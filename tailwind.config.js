/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'], heading: ['Inter', 'system-ui', 'sans-serif'] },
      colors: {
        brand: { 50: '#f6f6f5', 100: '#ececeb', 200: '#d8d9d7', 300: '#b8bab8', 400: '#8e9090', 500: '#5f6163', 600: '#42454a', 700: '#2a2d34', 800: '#1f2127', 900: '#16181d' },
        surface: '#f6f6f5',
        cream: '#fafafa',
        accent: { ink: '#16181d', red: '#b3402b' },
        wa: '#25d366',
      },
      borderRadius: { '2xl': '14px', '3xl': '18px', '4xl': '24px' },
      // `h-13` is used 38 times across 12 files -- every text input on
      // Products, Receipts, Customers, Expenses, Staff, Invoices, Bundles,
      // Refunds, the delivery pages and the CHECKOUT drawer. It is not a
      // Tailwind default (the scale jumps 12 -> 14), so it generated no CSS
      // at all and each of those inputs collapsed to its content height.
      // Measured on the Pixel: 366x28, well under the 44px a finger needs,
      // on the search boxes of both Receipts and Products.
      //
      // Defining it is the honest fix: the markup has always meant "a
      // comfortable input", and rewriting 38 call sites to h-12 would change
      // the intended size as well as the behaviour. 3.25rem sits exactly
      // where the 12/14 gap implies.
      spacing: { 13: '3.25rem' },
    },
  },
  plugins: [],
}
