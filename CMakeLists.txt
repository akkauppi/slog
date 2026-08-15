cmake_minimum_required(VERSION 3.16.0)

# PlatformIO installs this IDF component through lib_deps, outside IDF's
# conventional components/ directory, so make it visible to IDF CMake.
list(APPEND EXTRA_COMPONENT_DIRS
     "${CMAKE_CURRENT_LIST_DIR}/.pio/libdeps/xiao_esp32c3/esp_littlefs")
# All third-party components are pinned and installed by PlatformIO.
set(ENV{IDF_COMPONENT_MANAGER} 0)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(sauna_logger)
