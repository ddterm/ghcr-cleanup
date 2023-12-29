Docker registry cleanup
-----------------------

For every repository:

1. Images updated less than 1 day ago are kept

2. Images updated more than 1 year ago are deleted

3. Images with `org.opencontainers.image.version` label matching existing
tags/branches or open pull requests are kept

4. Everything else is deleted

## REST API pagination race condition

It seems that GitHub API pagination can "skip" a branch/tag/pull request
if another branch/tag/PR is deleted concurrently.

However, we mostly care about tags. Images for branches and pull requests
are not as precious and can be rebuilt if necessary.

Tags should never be deleted - so this isn't a real issue.
