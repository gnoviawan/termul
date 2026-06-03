cask "termul" do
  arch arm: "aarch64", intel: "x64"

  version "0.4.2"
  sha256 arm:   "a10a101561edd7e940a26361e17b7012cd45e2e537bd878e37beafbd918a329d",
         intel: "19a0d559508ca0d13891e900ada1c7b158ade9198645af9f8c39094345724cad"

  url "https://github.com/gnoviawan/termul/releases/download/v#{version}/Termul.Manager_#{version}_#{arch}.dmg"
  name "Termul Manager"
  desc "Terminal-native workspace and CLI agent manager"
  homepage "https://github.com/gnoviawan/termul"

  auto_updates true
  depends_on macos: :catalina

  app "Termul Manager.app"

  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/Termul Manager.app"]
  end

  zap trash: [
    "~/Library/Application Support/com.termul-manager.app",
    "~/Library/Caches/com.termul-manager.app",
    "~/Library/HTTPStorages/com.termul-manager.app",
    "~/Library/Logs/com.termul-manager.app",
    "~/Library/Preferences/com.termul-manager.app.plist",
    "~/Library/Saved Application State/com.termul-manager.app.savedState",
    "~/Library/WebKit/com.termul-manager.app",
  ]
end
