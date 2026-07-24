# Litra Glow — GNOME Shell extension.
#
# Everything installs into the user's home; the only privileged step is the
# udev rule (`make udev`), which is a one-off.
#
#   make install   build + install the extension (no sudo)
#   make udev      install the udev rule (sudo, once per machine)
#   make uninstall remove the extension again
#
# Run `make` on its own for the full target list.

UUID          := litra@soylu.me
LITRA_VERSION := 3.3.0

SRC       := src/$(UUID)
BUILD     := build/$(UUID)
CACHEDIR  := .cache
EXTDIR    := $(HOME)/.local/share/gnome-shell/extensions
DEST      := $(EXTDIR)/$(UUID)
UDEV_DEST := /etc/udev/rules.d/60-litra.rules
ZIP       := $(UUID).shell-extension.zip

# Map `uname -m` onto the upstream release asset suffix. An unsupported machine
# leaves ASSET empty, which the download recipe reports.
MACHINE       := $(shell uname -m)
ASSET_x86_64  := linux-amd64
ASSET_aarch64 := linux-aarch64
ASSET         := $(ASSET_$(MACHINE))

BINARY := litra_v$(LITRA_VERSION)_$(ASSET)
CACHED := $(CACHEDIR)/$(BINARY)
URL    := https://github.com/timrogers/litra-rs/releases/download/v$(LITRA_VERSION)/$(BINARY)

.PHONY: help build install udev uninstall uninstall-udev pack check clean distclean logs

help:
	@echo "litra-glow-gnome ($(UUID))"
	@echo
	@echo "  make install         build and install the extension into $(EXTDIR)"
	@echo "  make udev            install $(UDEV_DEST) (sudo, once per machine)"
	@echo "  make uninstall       remove the installed extension"
	@echo "  make uninstall-udev  remove the udev rule (sudo)"
	@echo
	@echo "  make build           stage the extension under build/ without installing"
	@echo "  make pack            build $(ZIP) for distribution"
	@echo "  make check           syntax-check extension.js and metadata.json"
	@echo "  make logs            follow gnome-shell's log"
	@echo "  make clean           remove build/ and the zip"
	@echo "  make distclean       also drop the downloaded binary cache"

# --- backend binary ---------------------------------------------------------
# Downloaded once, verified against checksums.txt, then cached. Never fetched
# again unless the version changes or `make distclean` is run.

$(CACHED):
	@test -n "$(ASSET)" || { echo "!! unsupported CPU architecture: $(MACHINE)"; exit 1; }
	@mkdir -p $(CACHEDIR)
	@echo ">> downloading litra v$(LITRA_VERSION) ($(ASSET))"
	@curl -fL --progress-bar --proto '=https' --tlsv1.2 -o $@.part "$(URL)"
	@expected=`awk '$$2 == "$(BINARY)" { print $$1 }' checksums.txt`; \
	actual=`sha256sum < $@.part | cut -d' ' -f1`; \
	if [ -z "$$expected" ]; then \
	  echo "!! no checksum recorded for $(BINARY) — add one to checksums.txt"; \
	  rm -f $@.part; exit 1; \
	fi; \
	if [ "$$expected" != "$$actual" ]; then \
	  echo "!! checksum mismatch for $(BINARY)"; \
	  echo "   expected $$expected"; \
	  echo "   got      $$actual"; \
	  rm -f $@.part; exit 1; \
	fi
	@mv $@.part $@
	@echo ">> checksum ok"

# --- build / install --------------------------------------------------------

build: $(CACHED)
	@rm -rf $(BUILD)
	@mkdir -p $(BUILD)
	@cp -a $(SRC)/. $(BUILD)/
	@install -Dm0755 $(CACHED) $(BUILD)/bin/litra
	@echo ">> staged $(BUILD)"

install: build
	@mkdir -p $(EXTDIR)
	@rm -rf $(DEST)
	@cp -a $(BUILD) $(DEST)
	@chmod 0755 $(DEST)/bin/litra
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

# --- distribution / housekeeping -------------------------------------------

# `gnome-extensions install` does not reliably preserve the executable bit on
# bin/litra, so this zip is for archiving and copying between machines — use
# `make install` to actually install.
pack: build
	@rm -f $(ZIP)
	@cd $(BUILD) && zip -rq $(CURDIR)/$(ZIP) .
	@echo ">> $(ZIP)"

check:
	@if command -v node >/dev/null 2>&1; then \
	  mkdir -p $(CACHEDIR); \
	  cp $(SRC)/extension.js $(CACHEDIR)/_check.mjs; \
	  node --check $(CACHEDIR)/_check.mjs && echo ">> extension.js: syntax ok"; \
	  rm -f $(CACHEDIR)/_check.mjs; \
	else \
	  echo "-- node not installed, skipping the JS syntax check"; \
	fi
	@python3 -m json.tool $(SRC)/metadata.json >/dev/null && echo ">> metadata.json: valid JSON"

logs:
	journalctl -f -o cat /usr/bin/gnome-shell

clean:
	@rm -rf build $(ZIP)
	@echo ">> cleaned (binary cache in $(CACHEDIR)/ kept)"

distclean: clean
	@rm -rf $(CACHEDIR)
