# Makefile for amber-focus native macOS app
# Compiles single-file SwiftUI app with release optimizations.

APP_NAME = amber-focus
SRC = amber-focus.swift
FRAMEWORKS = -framework IOKit

ENFORCER_NAME = retreat-enforcer
ENFORCER_SRC = retreat-enforcer.swift

.PHONY: all clean run enforcer

all: $(APP_NAME) $(ENFORCER_NAME)

$(APP_NAME): $(SRC)
	swiftc $(SRC) -o $(APP_NAME) -O $(FRAMEWORKS)

$(ENFORCER_NAME): $(ENFORCER_SRC)
	swiftc $(ENFORCER_SRC) -o $(ENFORCER_NAME) -O

enforcer: $(ENFORCER_NAME)

clean:
	rm -f $(APP_NAME) $(ENFORCER_NAME)

run: $(APP_NAME)
	./$(APP_NAME)
