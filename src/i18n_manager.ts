/*
 * @adonisjs/i18n
 *
 * (c) AdonisJS
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import Negotiator from 'negotiator'
import { RuntimeException } from '@poppinss/utils'
import type { Emitter } from '@adonisjs/core/events'
import type {
  I18nConfig,
  ManagerLoaderFactory,
  ManagerFormatterFactory,
  TranslationsFormatterContract,
  MissingTranslationEventPayload,
} from './types/main.js'

import debug from './debug.js'
import { I18n } from './i18n.js'
import { FsLoader } from './loaders/fs_loader.js'
import { IcuFormatter } from './formatters/icu_messages_formatter.js'

export class I18nManager {
  /**
   * i18n config
   */
  #config: I18nConfig

  /**
   * Reference to the emitter for emitting events
   */
  #emitter: Emitter<{ 'i18n:missing:translation': MissingTranslationEventPayload } & any>

  /**
   * List of translation formatters. Custom formatters can be
   * added using the "extend" method
   */
  #formatters: { [name: string]: ManagerFormatterFactory } = {
    icu: () => new IcuFormatter(),
  }

  /**
   * Reference to the formatter in use
   */
  #formatter?: TranslationsFormatterContract

  /**
   * List of translation loadrs. Custom loaders can be added using
   * the "extend" method.
   */
  #loaders: { [name: string]: ManagerLoaderFactory } = {
    fs: (config) => {
      return new FsLoader(config.loaders.fs!)
    },
  }

  /**
   * An array of supported locales inferred from the fallback locales
   * object + the translations directories.
   *
   * The array is only used when the config doesn't have an explicit
   * value.
   */
  #inferredLocales: string[] = []

  /**
   * Cached in-memory translations. The collection is a merged
   * copy of a
   */
  #translations: { [lang: string]: Record<string, string> } = {}

  /**
   * Find if translations has been cached or not
   */
  #hasCachedTranslations: boolean = false

  /**
   * Reference to the default locale defined inside the config file
   */
  get defaultLocale(): string {
    return this.#config.defaultLocale
  }

  /**
   * Check if the translations has been cached or not.
   * Use "reloadTranslations" method re-fetch translations
   */
  get hasCachedTranslations(): boolean {
    return this.#hasCachedTranslations
  }

  constructor(
    emitter: Emitter<{ 'i18n:missing:translation': MissingTranslationEventPayload } & any>,
    config: I18nConfig
  ) {
    this.#config = config
    this.#emitter = emitter
  }

  /**
   * Returns an array of locales supported by the application.
   *
   * The method returns locales by inspecting the translations,
   * when no explicit supportLocales are defined inside the
   * config file.
   */
  supportedLocales() {
    return this.#config.supportedLocales || this.#inferredLocales
  }

  /**
   * Returns an object of cached translations. The object is shared
   * by reference and hence mutations will mutate the original
   * copy
   */
  getTranslations() {
    return this.#translations
  }

  /**
   * Returns an object of translations for a given locale
   */
  getTranslationsFor(locale: string) {
    return this.#translations[locale] || {}
  }

  /**
   * Returns an instance of the translations formatter for the
   * active formatter
   */
  getFormatter() {
    /**
     * Lazily computing the formatter since we allow register custom
     * formatters after an instance of manager has been created
     */
    if (!this.#formatter) {
      const formatterFactory = this.#formatters[this.#config.translationsFormat]
      if (!formatterFactory) {
        throw new RuntimeException(`Invalid i18n formatter "${this.#config.translationsFormat}"`)
      }

      this.#formatter = formatterFactory(this.#config)
    }

    return this.#formatter
  }

  /**
   * Load translations using all the configured loaders.
   *
   * The loaded translations are cached forever and you must use
   * "reloadTranslations" method to reload them.
   */
  async loadTranslations() {
    if (!this.hasCachedTranslations) {
      await this.reloadTranslations()
    }
  }

  /**
   * Reload translations from the registered loaders
   */
  async reloadTranslations() {
    debug('loading translations')

    const translationsStack = await Promise.all(
      Object.keys(this.#config.loaders)
        .filter((loader) => {
          return this.#config.loaders[loader]?.enabled
        })
        .map((loader) => {
          const loaderFactory = this.#loaders[loader]
          if (!loaderFactory) {
            throw new RuntimeException(`Invalid i18n loader "${loader}"`)
          }

          return loaderFactory(this.#config).load()
        })
    )

    /**
     * Set flag to true
     */
    this.#hasCachedTranslations = true

    /**
     * Empty the existing translations object
     */
    this.#translations = {}

    /**
     * Compute inferred locales
     *
     * The inferred locales is the combination of
     *
     * - Default locale
     * - Fallback locales keys
     * - Locales detected from translations
     */
    this.#inferredLocales = [this.defaultLocale].concat(
      this.#config.fallbackLocales ? Object.keys(this.#config.fallbackLocales) : []
    )

    /**
     * Shallow merge translations from all the loaders
     */
    translationsStack.forEach((translations) => {
      Object.keys(translations).forEach((lang) => {
        /**
         * Collect inferred locales when not defined explicitly
         */
        if (!this.#inferredLocales.includes(lang)) {
          this.#inferredLocales.push(lang)
        }

        /**
         * Initialize language with an empty object
         */
        this.#translations[lang] = this.#translations[lang] || {}
        Object.assign(this.#translations[lang], translations[lang])
      })
    })
  }

  /**
   * Inspects the "accept-language" HTTP header and returns the
   * most appropriate language based upon the supported languages
   */
  getSupportedLocaleFor(userLanguage: string | string[]): string | null {
    /**
     * The "accept" package internally reads the "headers['accept-language']"
     * and therefore we do not need a full blown request object.
     *
     * The behavior is verified using tests
     */
    return (
      new Negotiator({
        headers: {
          'accept-language': Array.isArray(userLanguage) ? userLanguage.join(',') : userLanguage,
        },
      }).language(this.supportedLocales()) || null
    )
  }

  /**
   * Returns the fallback locale for a given locale. Returns the default
   * locale when no fallback is defined
   */
  getFallbackLocaleFor(locale: string): string {
    /**
     * Return default locale when no fallbacks are
     * configured
     */
    if (!this.#config.fallbackLocales) {
      return this.defaultLocale
    }

    /**
     * Return fallback locale for the input local (when configured).
     * Otherwise use default locale.
     */
    return this.#config.fallbackLocales[locale] || this.defaultLocale
  }

  /**
   * Returns an instance of I18n for a given locale
   */
  locale(locale: string) {
    return new I18n(locale, this.#emitter, this)
  }

  /**
   * Returns the fallback message for an identifier and locale
   * when the "config.fallback" property is defined.
   *
   * Otherwise returns undefined
   */
  getFallbackMessage(identifier: string, locale: string): string | undefined {
    return this.#config.fallback?.(identifier, locale)
  }

  /**
   * Extend by adding custom formatters and loaders
   */
  extend(name: string, type: 'loader', callback: ManagerLoaderFactory): void
  extend(name: string, type: 'formatter', callback: ManagerFormatterFactory): void
  extend(
    name: string,
    type: 'loader' | 'formatter',
    callback: ManagerLoaderFactory | ManagerFormatterFactory
  ): void {
    debug('adding custom %s', type)

    if (type === 'loader') {
      this.#loaders[name] = callback as ManagerLoaderFactory
    } else {
      this.#formatters[name] = callback as ManagerFormatterFactory
    }
  }
}
