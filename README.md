# software-factory

Tooling for running a software factory: AI agents on [Paperclip](https://github.com/paperclipai/paperclip) that write, review and test code as draft pull requests, with one person approving and merging. [`watcher/`](watcher/README.md) holds factory-watcher, a plain Node script with no AI model that watches the factory's open PRs in any set of GitHub repos and opens a Paperclip task only when an agent has real work to do.
