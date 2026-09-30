TSC   ?= tsc
BIOME ?= biome
STOW  ?= stow
CURL  ?= curl

install: pre-install
	$(STOW) -v pi
.PHONY: install

uninstall:
	$(STOW) -D pi
.PHONY: unstall

pre-install:
	mkdir -p ~/.pi/agent/bin ~/.pi/agent/sessions
.PHONY: pre-stow

## Run all checks
## Use to confirm completed change sets.
check:
	@command -v $(TSC) >/dev/null 2>&1 || { echo "Missing system tsc on PATH"; exit 127; }
	$(TSC) --project tsconfig.json --noEmit
	@command -v $(BIOME) >/dev/null 2>&1 || { echo "Missing system biome on PATH"; exit 127; }
	$(BIOME) check .
.PHONY: check


## Apply fixes
## Safe and fast, run before trying manual fixing.
fix:
	@command -v $(BIOME) >/dev/null 2>&1 || { echo "Missing system biome on PATH"; exit 127; }
	$(BIOME) check --write --unsafe .
.PHONY: fix

update:
	pi update && $(MAKE) deps && $(MAKE) check
.PHONY: update

# --------------------------------------------------------------------------- #
#                                Dependencies                                 #
# --------------------------------------------------------------------------- #
PI_VERSION := $(shell pi --version)
PACKAGES := \
	@types/node:26.5.1 \
	@earendil-works/pi-coding-agent:$(PI_VERSION) \
	@earendil-works/pi-agent-core:$(PI_VERSION) \
	@earendil-works/pi-ai:$(PI_VERSION) \
	@earendil-works/pi-tui:$(PI_VERSION) \
	typebox:1.3.27

pkg-name    = $(word 1,$(subst :, ,$1))
pkg-version = $(word 2,$(subst :, ,$1))
pkg-slug    = $(lastword $(subst /, ,$(call pkg-name,$1)))
pkg-tarball = https://registry.npmjs.org/$(call pkg-name,$1)/-/$(call pkg-slug,$1)-$(call pkg-version,$1).tgz

TARGETS := $(foreach p,$(PACKAGES),node_modules/$(call pkg-name,$p))

deps: $(TARGETS)
.PHONY: deps $(TARGETS)

define fetch-rule
node_modules/$(call pkg-name,$1):
	@rm -rf "$$@"
	@mkdir -p "$$@"
	@echo "Fetching $1..."
	$(CURL) -sf "$(call pkg-tarball,$1)" | tar -xz --strip-components=1 -C "$$@"
	@echo "Done: $$@"
endef

$(foreach p,$(PACKAGES),$(eval $(call fetch-rule,$p)))

deps-clean:
	rm -rf node_modules
.PHONY: deps-clean

deps-list:
	@$(foreach p,$(PACKAGES),echo "$(p)  →  $(call pkg-tarball,$(p))";)
.PHONY: deps-list
