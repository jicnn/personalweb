import { defineConfig, svgoOptimizer } from 'astro/config';
import type { Config } from 'svgo';

import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';
import icon from 'astro-icon';
import { unified, rehypeHeadingIds } from '@astrojs/markdown-remark';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import astroExpressiveCode from 'astro-expressive-code';
import { externalLinking } from './src/plugins/external-linking';
import { rehypeYoutubePlugin } from './src/plugins/youtube-embed';
import { themeConfig } from './theme.config';
import { setOnDemandPrerender, getOnDemandSitemapPages } from './src/utils/on-demand-render';

// i18n config for sitemap integration
export const sitemap_i18n = {
  defaultLocale: themeConfig.i18n.defaultLocale,
  locales: themeConfig.i18n.locales.reduce((acc, lang) => ({ ...acc, [lang]: lang }), {}),
};

// Shared SVGO config used by the experimental svgOptimizer, astro-icon, and astro-compress.
const svgoConfig: Config = {
  multipass: true,
  floatPrecision: 5,
  plugins: [
    {
      name: 'preset-default',
      params: {
        overrides: {
          cleanupIds: false,
          inlineStyles: false,
          mergeStyles: false,
          removeHiddenElems: false,
          convertShapeToPath: false,
          convertEllipseToCircle: false,
          convertPathData: false,
          convertTransform: {
            degPrecision: 1,
            transformPrecision: 3,
          },
          removeEmptyAttrs: false,
          removeDesc: false,
        },
      },
    },
    'convertStyleToAttrs',
    'removeRasterImages',
    'reusePaths',
    {
      name: 'removeXlink',
      params: { includeLegacy: true },
    },
    {
      name: 'prefixIds',
      params: {
        delim: '_',
        prefix: () => Math.random().toString(36).slice(2, 8),
        prefixIds: true,
        prefixClassNames: false,
      },
    },
  ],
};

// https://astro.build/config
export default defineConfig({
  site: themeConfig.site,
  output: 'static',
  trailingSlash: 'never',

  build: {
    format: 'file',
  },

  image: {
    remotePatterns: [{ protocol: 'https' }], // only allows remote images with https, see https://docs.astro.build/en/guides/images/#authorizing-remote-images for more options
    responsiveStyles: true, // set false for less convenience, but more control; https://docs.astro.build/en/reference/configuration-reference/#imageresponsivestyles
    layout: 'constrained',
    // Astro generates variants for each width in this list (plus the image's intrinsic width).
    // Defaults are [640, 750, 828, 1080, 1200, 1920]; This is our recommendation based on Tailwind defaults.
    breakpoints: [414, 576, 768, 976, 1440, 1600],
  },

  experimental: {
    svgOptimizer: svgoOptimizer(svgoConfig),
  },

  vite: {
    plugins: [tailwindcss()],
    optimizeDeps: {
      include: ['debug', 'ms', 'reading-time', 'fdir > picomatch', 'expressive-code > postcss'],
    },
  },

  markdown: {
    processor: unified({
      rehypePlugins: [
        rehypeYoutubePlugin, // custom plugin to create optimized youtube embeds from youtube links in markdown content; see src/plugins/youtube-embed.ts for details
        rehypeHeadingIds, // adds ids to markdown headings, which are needed for the autolink plugin and also the table of contents generation
        [
          rehypeAutolinkHeadings, // adds anchor links to markdown headings; needs to be added after the rehypeHeadingIds plugin, so that it can find the generated ids
          {
            behavior: 'wrap',
          },
        ],
        [
          externalLinking, // custom plugin to add target="_blank" and rel="noopener" to external links in markdown content; see src/plugins/external-linking.ts for details
          {
            domain: themeConfig.site,
          },
        ],
      ],
    }),
  },

  i18n: {
    defaultLocale: themeConfig.i18n.defaultLocale,
    locales: themeConfig.i18n.locales,
    routing: {
      prefixDefaultLocale: false,
      fallbackType: 'redirect',
    },
  },

  integrations: [
    setOnDemandPrerender,
    sitemap({
      i18n: sitemap_i18n,
      customPages: getOnDemandSitemapPages(),
      customSitemaps: [themeConfig.site.replace(/\/+$/, '') + '/dynamic-events-sitemap.xml'],
    }),
    icon({
      svgoOptions: svgoConfig,
    }),
    astroExpressiveCode(),
    (await import('astro-compress')).default({
      CSS: false,
      HTML: {
        'html-minifier-terser': {
          removeAttributeQuotes: false,
        },
      },
      SVG: {
        svgo: svgoConfig,
      },
    }),
  ],
});
