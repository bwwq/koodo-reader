# reader-legado server modifications

The engine vendors reader-legado v2.7.2 under its original GPL-3.0 license.
The original license remains at `vendor/reader-legado/LICENSE`.

Koodo applies `patches/reader-legado-webview.patch` during CI and container
builds. The patch adds server-side WebView callbacks, a restricted set of
client compatibility APIs, stable pseudonymous device values, and `jsLib`
evaluation support. JVM class access remains controlled by the engine's Rhino
ClassShutter. These modifications are distributed as source with the rest of
this AGPL-3.0 project.
