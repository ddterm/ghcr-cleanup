Docker registry cleanup
-----------------------

For every repository:

1. Images created less than 1 day ago are kept

2. Images created more than 1 year ago are deleted

3. Images with no defined build date (cache?) are kept

4. Images with `org.opencontainers.image.version` label matching existing
tags/branches or open pull requests are kept

5. Everything else is deleted

## REST API pagination race condition

It seems that GitHub API pagination can "skip" a branch/tag/pull request
if it's deleted concurrently.

However, we mostly care about tags. Images for branches and pull requests
are not as precious and can be rebuilt if necessary.

Tags should never be deleted - so this isn't a real issue.
