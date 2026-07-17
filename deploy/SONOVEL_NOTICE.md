# So Novel Engine

The optional Chinese aggregate source uses the unmodified So Novel container:

- Project: https://github.com/freeok/so-novel
- Version: 1.11.0
- Reviewed commit: 7293d2966f62061805ea215d4ed193b6f5b8ba0c
- License: GNU Affero General Public License v3.0

The container is reachable only from the private Docker network. Koodo Reader's
Go service provides authentication, per-account search-result isolation, task
serialization, generated-file ownership checks, and removal of transient files.
