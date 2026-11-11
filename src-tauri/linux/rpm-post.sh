#!/bin/sh

# gh-1580: Termul Manager 0.4.52 and older shipped /usr/bin/rg. Installed with
# `rpm -i --replacefiles` next to the distro ripgrep, that package took over the
# file, and rpm deletes it when it removes termul-manager after this scriptlet.
# rpm runs no scriptlet of ours after that removal, so tell the user how to
# get rg back.
if rpm -qf /usr/bin/rg 2>/dev/null | grep -q '^termul-manager-' && rpm -q ripgrep >/dev/null 2>&1; then
  echo "troupe: removing termul-manager also removes /usr/bin/rg, which it took over from ripgrep. Run 'dnf reinstall ripgrep' afterwards." >&2
fi

exit 0
