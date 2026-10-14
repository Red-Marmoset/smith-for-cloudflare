// Main.cpp - portable console entry point for the Smith binary.
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "App.h"

#include <cstdio>

int main(int argc, char** argv)
{
    // Unbuffer stdout/stderr so log lines reach a redirected file immediately.
    // (When stdout is a pipe/file the CRT fully buffers it, so a hard-killed
    // coordinator loses every unflushed log line - log volume is far too low
    // for unbuffered writes to matter.)
    std::setvbuf(stdout, nullptr, _IONBF, 0);
    std::setvbuf(stderr, nullptr, _IONBF, 0);
    return Smith::AppMain(argc, argv);
}
