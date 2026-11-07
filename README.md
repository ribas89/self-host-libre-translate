# GitHub repositories are now mirror only

Due to recent changes in GitHub's direction, development has migrated to: https://git.ribas89.co.uk/

Have a issue/question? https://link.ribas89.co.uk/ask


Thank you for your support ❤️!

# Self Host Libre Translate

A Firefox extension for translating webpages and selected text using a LibreTranslate server you configure yourself. No server is preconfigured. HTTP and HTTPS are supported.

Translation can remain enabled while navigating within a tab. Selection translation, automatic language detection, an optional API key for servers that require one, and optional local caching are supported. Caching is enabled by default after user consent, can be disabled or cleared, and never persists private-browsing translations.

Page text and selections are sent only to the configured server. If set, the API key is stored in Firefox and sent to that server in translation and language-detection requests; HTTP is unencrypted. Users are responsible for choosing and trusting their server. The extension is independently developed, vibecoded, experimental, and supplied as-is. Expect bugs. Report problems using Issues in the official project repository; maintenance and responses are not guaranteed.

## Package as XPI

On Linux with `zip` installed, run this in the repository root:

```sh
zip -r self-host-libre-translate-1.6.1-unsigned.xpi \
  manifest.json background.js code_prose.js content.js \
  popup.html popup.css popup.js \
  consent.html consent.css consent.js \
  icons/ LICENSE
```

An XPI is an ordinary ZIP archive with a `.xpi` extension. `manifest.json` must be at the archive root. The result is unsigned and must be signed by Mozilla for regular Firefox installation.

## License

MIT. See [LICENSE](LICENSE).
