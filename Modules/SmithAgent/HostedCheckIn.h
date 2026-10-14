#pragma once
#include <string>
namespace Smith {
// Parse fixed git --numstat -z output; malformed, unsafe or oversized input is incomplete.
std::string HostedCheckInReport(const std::string& eventId, const std::string& base, const std::string& head, const std::string& numstat, bool ancestor);
}
