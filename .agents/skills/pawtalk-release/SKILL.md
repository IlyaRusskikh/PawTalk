---
name: pawtalk-release
description: Prepare or publish an explicitly requested PawTalk component release with independent versions, bilingual notes and separate merge, tag and publication approvals.
metadata:
  short-description: Prepare and gate component releases
---

1. Read [release process](../../../docs/RELEASING.md),
   [Git rules](../../../agents/rules/development.md) and
   [GitHub setup](../../../agents/rules/github.md). Determine the component and
   previous published release using GitHub Releases, not source versions.
2. In work/{service}-v{version} from current main prepare independent version
   sources, CHANGELOG and reviewed RU/EN docs/releases/<tag>.md with exact assets,
   upgrade requirements and limitations. Preserve published historical notes.
3. Run applicable final-state CI locally plus packaged smoke after Client installer;
   report unavailable environments. Review diff/public guard; push branch and PR.
4. Hand off PR CI link without polling. Successful CI plus explicit owner merge
   permission precede squash merge; delete branch. Ask separately before tag creation.
5. Only tag a commit contained in main with matching component version. Send the
   direct tag workflow URL. Build/sign/verify must succeed before separately
   approved release-publish publication. Environment settings need owner setup.
6. Never replace tags/assets/images or publish partial/failed releases. A failed
   pushed release tag requires a new version/PR. No release for docs-only changes,
   no post-release catalog/version commit. Pages derives public links from Releases.
