# Self Host Libre Translate

A Firefox extension for translating webpages and selected text using a LibreTranslate server you configure yourself. No server is preconfigured. HTTP and HTTPS are supported.

Translation can remain enabled while navigating within a tab. Selection translation, automatic language detection, and optional local caching are supported. Caching is enabled by default after user consent, can be disabled or cleared, and never persists private-browsing translations.

Page text and selections are sent only to the configured server. Users are responsible for choosing and trusting their server. The extension is independently developed, vibecoded, experimental, and supplied as-is. Expect bugs. Report problems using Issues in the official project repository; maintenance and responses are not guaranteed.

## Package as XPI

On Linux with `zip` installed, run this in the repository root:

```sh
zip -r self-host-libre-translate-1.5.20-unsigned.xpi \
  manifest.json background.js code_prose.js content.js \
  popup.html popup.css popup.js \
  consent.html consent.css consent.js \
  icons/ LICENSE
```

An XPI is an ordinary ZIP archive with a `.xpi` extension. `manifest.json` must be at the archive root. The result is unsigned and must be signed by Mozilla for regular Firefox installation.

## License

MIT. See [LICENSE](LICENSE).
