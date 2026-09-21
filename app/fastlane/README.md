fastlane documentation
----

# Installation

Make sure you have the latest version of the Xcode command line tools installed:

```sh
xcode-select --install
```

For _fastlane_ installation instructions, see [Installing _fastlane_](https://docs.fastlane.tools/#installing-fastlane)

# Available Actions

## iOS

### ios staging

```sh
[bundle exec] fastlane ios staging
```

Build staging and upload it to TestFlight

### ios production

```sh
[bundle exec] fastlane ios production
```

Build production and upload it to TestFlight

### ios certificates

```sh
[bundle exec] fastlane ios certificates
```

Fetch or create signing certificates and profiles for every bundle id

----


## Android

### android staging

```sh
[bundle exec] fastlane android staging
```

Build staging and upload it to Play internal testing

### android production

```sh
[bundle exec] fastlane android production
```

Build production and upload it to Play internal testing

----

This README.md is auto-generated and will be re-generated every time [_fastlane_](https://fastlane.tools) is run.

More information about _fastlane_ can be found on [fastlane.tools](https://fastlane.tools).

The documentation of _fastlane_ can be found on [docs.fastlane.tools](https://docs.fastlane.tools).
