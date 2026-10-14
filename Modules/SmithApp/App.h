// App.h - Smith application entry point.
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

namespace Smith
{
    // Parses the subcommand (coordinator | agent | version | help) and runs it.
    // Returns a process exit code.
    int AppMain(int argc, char** argv);

    const char* VersionString();
}
