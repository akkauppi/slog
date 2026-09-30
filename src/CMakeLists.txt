idf_component_register(
    SRCS "main.cpp" "session_logger.cpp" "retention_policy.cpp"
         "session_store.cpp" "session_store_posix.cpp"
         "probe_config.cpp" "probe_config_store.cpp"
         "../lib/saunan_wire/src/saunan_wire.cpp"
         "../lib/saunan_link/src/radio_config.cpp" "../lib/saunan_link/src/radio_link.cpp"
    INCLUDE_DIRS "." "../lib/saunan_wire/src" "../lib/saunan_link/src"
    REQUIRES framework-arduinoespressif32 esp_littlefs espcoredump esp_system
             nvs_flash esp_wifi bootloader_support
)
