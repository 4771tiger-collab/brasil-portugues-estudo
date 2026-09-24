/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // ブラジル国旗 + 落ち着いた学習向けパレット
        brand: {
          green: "#1b9e57",
          yellow: "#f4c542",
          blue: "#2d6cdf",
          ink: "#1c2433",
        },
      },
      fontFamily: {
        sans: [
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Hiragino Kaku Gothic ProN",
          "Meiryo",
          "sans-serif",
        ],
      },
      keyframes: {
        "fade-in": {
          "0%": { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "pop": {
          "0%": { transform: "scale(0.96)" },
          "100%": { transform: "scale(1)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.25s ease-out",
        "pop": "pop 0.15s ease-out",
      },
    },
  },
  plugins: [],
};
