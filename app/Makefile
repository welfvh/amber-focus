# Makefile for the retreat enforcer (user LaunchAgent that quits non-allowlisted apps).

ENFORCER_NAME = retreat-enforcer
ENFORCER_SRC = retreat-enforcer.swift

.PHONY: all clean

all: $(ENFORCER_NAME)

$(ENFORCER_NAME): $(ENFORCER_SRC)
	swiftc $(ENFORCER_SRC) -o $(ENFORCER_NAME) -O

clean:
	rm -f $(ENFORCER_NAME)
