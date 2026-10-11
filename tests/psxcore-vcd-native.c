/* Test adapter only. Link the unmodified, authoritative PSXCore src/vcd.c. */
#include "psxcore_vcd.h"
#include <stdio.h>
#include <stdint.h>
#include <sys/stat.h>
int main(int argc, char **argv) {
    if (argc != 2) return 2;
    struct stat st;
    if (stat(argv[1], &st)) return 2;
    FILE *file = fopen(argv[1], "rb");
    if (!file) return 2;
    unsigned char header[NP_VCD_HEADER_BYTES];
    size_t size = fread(header, 1, sizeof(header), file);
    fclose(file);
    const char *error = np_vcd_check(header, size, (uint64_t)st.st_size, NULL);
    if (error) { fprintf(stderr, "%s\n", error); return 1; }
    puts("valid"); return 0;
}
