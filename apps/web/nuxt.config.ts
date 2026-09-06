import tailwindcss from '@tailwindcss/vite'

export default defineNuxtConfig({
  compatibilityDate: '2026-09-06',
  devtools: { enabled: false },
  modules: ['shadcn-nuxt'],
  shadcn: { prefix: 'Ui', componentDir: './app/components/ui' },
  css: ['~/assets/css/main.css'],
  vite: { plugins: [tailwindcss()] },
  nitro: {
    preset: 'node-server',
    externals: { inline: ['@servitas/core', '@servitas/contracts'] },
  },
  app: {
    head: {
      title: 'Servitas',
      meta: [{ name: 'description', content: 'Your apps. Your server. One place to manage them.' }],
    },
  },
})
