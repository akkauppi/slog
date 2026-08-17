idf_component_register(
    SRCS "main.cpp" "session_logger.cpp" "retention_policy.cpp"
    INCLUDE_DIRS "."
    REQUIRES framework-arduinoespressif32 esp_littlefs espcoredump esp_system
)
