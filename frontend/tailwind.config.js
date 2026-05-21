export default {
  content: ['./index.html','./src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        gold: { DEFAULT:'#C8A84B', dim:'#8a7133', light:'#f0d07a' },
        dark: { DEFAULT:'#0A0A0A', 2:'#111111', 3:'#1A1A1A', 4:'#242424', 5:'#2E2E2E' },
        win: '#4CAF50', loss: '#C0392B',
      },
      fontFamily: { display:['"Bebas Neue"','sans-serif'], body:['"DM Sans"','sans-serif'] },
    },
  },
  plugins: [],
};
