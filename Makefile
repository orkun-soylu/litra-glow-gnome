# Litra Glow — GNOME Shell extension.
#
# Everything installs into the user's home; the only privileged step is the
# udev rule (`make udev`), which is a one-off.
#
#   make install   install the extension (no sudo)
#   make udev      install the udev rule (sudo, once per machine)
#   make uninstall remove the extension again
#
# Run `make` on its own for the full target list.

UUID      := litra@soylu.me
SRC       := src/$(UUID)
EXTDIR    := $(HOME)/.local/share/gnome-shell/extensions
DEST      := $(EXTDIR)/$(UUID)
UDEV_DEST := /etc/udev/rules.d/60-litra.rules
ZIP       := $(UUID).shell-extension.zip
FILES     := metadata.json extension.js device.js protocol.js

.PHONY: help install udev uninstall uninstall-udev pack check clean logs

help:
	@echo "litra-glow-gnome ($(UUID))"
	@echo
	@echo "  make install         install the extension into $(EXTDIR)"
	@echo "  make udev            install $(UDEV_DEST) (sudo, once per machine)"
	@echo "  make uninstall       remove the installed extension"
	@echo "  make uninstall-udev  remove the udev rule (sudo)"
	@echo
	@echo "  make pack            build $(ZIP) for distribution"
	@echo "  make check           syntax-check the sources and run the protocol tests (node)"
	@echo "  make logs            follow gnome-shell's log"
	@echo "  make clean           remove the zip"

# Deliberately not dependent on `check`: the machine that installs the
# extension need not have node.
install:
	@mkdir -p $(EXTDIR)
	@rm -rf $(DEST)
	@mkdir -p $(DEST)
	@cd $(SRC) && cp -f $(FILES) $(DEST)/
	@echo ">> installed $(DEST)"
	@gnome-extensions enable $(UUID) 2>/dev/null \
	  && echo ">> enabled" \
	  || echo ">> not enabled yet — run 'gnome-extensions enable $(UUID)' after the next login"
	@echo
	@echo "   Log out and back in: Wayland cannot reload GNOME Shell in place."

udev:
	sudo install -Dm0644 udev/60-litra.rules $(UDEV_DEST)
	sudo udevadm control --reload-rules
	sudo udevadm trigger --subsystem-match=hidraw
	@echo ">> udev rule installed — unplug and replug the Litra"

uninstall:
	@gnome-extensions disable $(UUID) 2>/dev/null || true
	@rm -rf $(DEST)
	@echo ">> removed $(DEST)"
	@echo "   the udev rule is kept; 'make uninstall-udev' removes it too"

uninstall-udev:
	sudo rm -f $(UDEV_DEST)
	sudo udevadm control --reload-rules

pack:
	@rm -f $(ZIP)
	@cd $(SRC) && zip -q $(CURDIR)/$(ZIP) $(FILES)
	@echo ">> $(ZIP)"

check:
	@tmp=`mktemp -d`; trap 'rm -rf $$tmp' EXIT; \
	for f in $(SRC)/*.js; do \
	  cp $$f $$tmp/check.mjs && node --check $$tmp/check.mjs || exit 1; \
	  echo ">> $$f: syntax ok"; \
	done
	@python3 -m json.tool $(SRC)/metadata.json >/dev/null && echo ">> metadata.json: valid JSON"
	@node tools/selftest.mjs | tail -1

logs:
	journalctl -f -o cat /usr/bin/gnome-shell

clean:
	@rm -f $(ZIP)
	@echo ">> cleaned"
