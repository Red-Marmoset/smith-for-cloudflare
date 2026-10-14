// Base64.cpp - base64 / base64url codec (see Base64.h).
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "Base64.h"

namespace Smith
{
    static const char* kStd = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    static const char* kUrl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    static std::string EncodeWith(const std::string& data, const char* a, bool pad)
    {
        std::string out;
        size_t i = 0;
        while (i + 3 <= data.size())
        {
            unsigned n = ((unsigned char)data[i] << 16) | ((unsigned char)data[i + 1] << 8) | (unsigned char)data[i + 2];
            out.push_back(a[(n >> 18) & 63]); out.push_back(a[(n >> 12) & 63]);
            out.push_back(a[(n >> 6) & 63]);  out.push_back(a[n & 63]);
            i += 3;
        }
        size_t rem = data.size() - i;
        if (rem == 1)
        {
            unsigned n = (unsigned char)data[i] << 16;
            out.push_back(a[(n >> 18) & 63]); out.push_back(a[(n >> 12) & 63]);
            if (pad) { out.push_back('='); out.push_back('='); }
        }
        else if (rem == 2)
        {
            unsigned n = ((unsigned char)data[i] << 16) | ((unsigned char)data[i + 1] << 8);
            out.push_back(a[(n >> 18) & 63]); out.push_back(a[(n >> 12) & 63]); out.push_back(a[(n >> 6) & 63]);
            if (pad) out.push_back('=');
        }
        return out;
    }

    std::string Base64Encode(const std::string& data)    { return EncodeWith(data, kStd, true); }
    std::string Base64UrlEncode(const std::string& data) { return EncodeWith(data, kUrl, false); }

    static int DecVal(char c)
    {
        if (c >= 'A' && c <= 'Z') return c - 'A';
        if (c >= 'a' && c <= 'z') return c - 'a' + 26;
        if (c >= '0' && c <= '9') return c - '0' + 52;
        if (c == '+' || c == '-') return 62;
        if (c == '/' || c == '_') return 63;
        return -1;
    }

    bool Base64UrlDecode(const std::string& in, std::string& out)
    {
        out.clear();
        int buf = 0, bits = 0;
        for (char c : in)
        {
            if (c == '=') break;                                  // padding -> done
            if (c == '\r' || c == '\n' || c == ' ' || c == '\t') continue;
            int v = DecVal(c);
            if (v < 0) { out.clear(); return false; }
            buf = (buf << 6) | v;
            bits += 6;
            if (bits >= 8)
            {
                bits -= 8;
                out.push_back((char)((buf >> bits) & 0xFF));
            }
        }
        return true;
    }
}
