# Makefile for the retreat enforcer (user LaunchAgent that quits non-allowlisted apps).

ENFORCER_NAME = retreat-enforcer
ENFORCER_SRC = retreat-enforcer.swift

.PHONY: all clean

all: $(ENFORCER_NAME)

# Build to a new file, then rename: overwriting the running binary in place keeps its
# inode, and macOS then kills the process for an invalid code signature.
$(ENFORCER_NAME): $(ENFORCER_SRC)
	swiftc $(ENFORCER_SRC) -o $(ENFORCER_NAME).new -O
	mv -f $(ENFORCER_NAME).new $(ENFORCER_NAME)

clean:
	rm -f $(ENFORCER_NAME)
