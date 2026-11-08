{
  "targets": [{
    "target_name": "pawtalk",
    "sources": ["pawtalk.cc"],
    "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
    "defines": ["NAPI_CPP_EXCEPTIONS", "NOMINMAX", "WIN32_LEAN_AND_MEAN", "_WIN32_WINNT=0x0A00"],
    "msvs_settings": { "VCCLCompilerTool": { "ExceptionHandling": 1, "AdditionalOptions": ["/std:c++17"] } },
    "libraries": ["ole32.lib", "uuid.lib", "user32.lib"]
  }]
}
