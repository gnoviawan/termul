#!/bin/sh
set -e

# gh-1580: Termul Manager 0.4.52 and older shipped /usr/bin/rg. Installed with
# `dpkg -i --force-overwrite` next to the distro ripgrep, that package took over
# the file, so removing it (which installing Troupe does) deletes the user's rg.
# Keep a copy here; postinst puts it back once the old package is gone.
if [ "$1" = install ] || [ "$1" = upgrade ]; then
  if dpkg-query -S /usr/bin/rg 2>/dev/null | grep -Eq '(^|[ ,])termul-manager[,:]' &&
    [ "$(dpkg-query -W -f='${db:Status-Status}' ripgrep 2>/dev/null)" = installed ]; then
    cp -p /usr/bin/rg /usr/bin/.rg.troupe-gh1580
  fi
fi

exit 0
