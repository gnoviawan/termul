#!/bin/sh
set -e

# gh-1580: restore the rg that preinst saved if removing termul-manager
# deleted it.
if [ "$1" = configure ] && [ -e /usr/bin/.rg.troupe-gh1580 ]; then
  if [ -e /usr/bin/rg ]; then
    rm -f /usr/bin/.rg.troupe-gh1580
  else
    mv /usr/bin/.rg.troupe-gh1580 /usr/bin/rg
    echo "troupe: kept /usr/bin/rg after removing termul-manager. Run 'apt install --reinstall ripgrep' to hand it back to ripgrep." >&2
  fi
fi

exit 0
