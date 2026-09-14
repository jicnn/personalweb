import type { ThemeConfig } from './types/theme-config.d.ts';

// language files from ./src/i18n
// The `with { type: 'json' }` import attribute is required so this file can also be
// imported from a plain ESM context (e.g. `ec.config.mjs`, which Node loads directly).
import enStrings from './src/i18n/en.json' with { type: 'json' };
import zhStrings from './src/i18n/zh.json' with { type: 'json' };

export const themeConfig: ThemeConfig = {
  site: import.meta.env?.SITE_OVERRIDE || 'https://personalweb-jicnn.vercel.app',
  primaryColor: '#f26430',
  themeColor: '#50168a',
  generateWebmanifest: true,
  name: 'Jicnn Tech',
  shortName: 'Jicnn',
  darkMode: true,
  robots: import.meta.env?.ROBOTS || 'index, follow',
  xHandle: 'jicnn_tech',

  author: {
    type: 'Person',
    name: 'Jicnn',
    url: 'https://github.com/jicnn',
    image: '',
  },
  publisher: {
    type: 'Person',
    name: 'Jicnn',
    url: 'https://github.com/jicnn',
    image: '',
  },

  // I18n
  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'zh'],
    languages: {
      en: 'English',
      zh: '中文',
    },
    languageModules: {
      en: enStrings,
      zh: zhStrings,
    },
    translatedStructuredData: {},
  },

  // md(x) code block rendering
  expressiveCodeThemes: {
    light: 'min-light',
    dark: 'min-dark',
  },

  // content/article settings
  articles: {
    imageFallback: true,
    gridView: true,
    textOverImage: false,
    categories: true, // if set false, make sure to also remove category directories under /pages
    tags: true, // if set false, make sure to also remove tag directories under /pages
    entriesPerPage: 4,
    tocMaxDepth: 3,
    defaults: {
      author: {
        name: 'Jicnn',
        url: 'https://github.com/jicnn',
      },
    },
    social: {
      xHandle: 'jicnn_tech',
      buttons: {
        email: true,
        facebook: false,
        hackernews: false,
        linkedin: false,
        pinterest: false,
        reddit: false,
        telegram: false,
        x: true,
        whatsapp: false,
      },
      buttonsSmallScreen: {
        email: true,
        facebook: false,
        hackernews: false,
        linkedin: false,
        pinterest: false,
        reddit: false,
        telegram: false,
        x: true,
        whatsapp: false,
      },
    },
  },

  promotions: {
    newsletterSignup: false,
    footerBanner: false,
    navAd: false,
    topBanner: false,
    heroChip: false,
  },

  // Collections listed here will be rendered on-demand (SSR) instead of prerendered.
  // Set to [] for a fully static build (suitable for Vercel and other static hosts).
  onDemandRenderedCollections: [],

  // you can also dynamically integrate events from your Add to Calendar PRO account (https://add-to-calendar-pro.com/), having your API key set as environment variable ADD_TO_CALENDAR_PRO_API_KEY.
  dynamicEvents: {
    pullFromAddToCalendarPro: false,
    filterBy: {
      from: '',
      to: '',
      group: '',
    },
  },

  // LLM and coding assistant settings
  llms: {
    autoGeneration: true,
    intro: 'Jicnn Tech - A personal tech blog and technical support service platform. Sharing knowledge about software development, programming, and technology.',
    excludePagesPattern: ['/integration/**'],
    includePages: [],
    addArticles: 'selected',
    addEvents: 'all',
    addFAQ: 'all',
  },

  askAiTrigger: '',
};
