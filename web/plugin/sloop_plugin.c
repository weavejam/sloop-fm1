/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 weavejam
 * Parts derived from SLOOP (dev_frame after main.c fm1_main's loop, dev_power_on after its boot, tutti_render after
 * audio.c audio_block, tutti_stem_render after fx.c mix_block's master section, preview_note's velocity after
 * firmware/host/preview.c): Copyright (C) 2026 isod89 and the SLOOP contributors; Felucca: Copyright (C) 2026 Leo
 * Kuroshita (@kurogedelic), Hügelton Instruments. The device's design (the clock driven by the audio asked for, the
 * flash handed back before boot, the headless render) follows Felucca's web/emu and web/plugin (weavejam/Felucca).
 *
 * SLOOP for tuttidaw (protocol tutti-plugin/0, web/plugin/README.md): the whole SLOOP firmware (src/felucca.c's
 * sources, in its order) compiled to WebAssembly against a simulated FM-1, built with SLOOP_TUTTI:
 *   - the device (the plugin page's live SLOOP, in an AudioWorklet): the clock follows the audio asked for, the main
 *     loop runs every 15 ms (the editor's SysEx, the autosave, the sections' and the settings' writes); the editor
 *     (web/editor.html) talks to it over a virtual MIDI port with the editor protocol (web/EDITOR_PROTOCOL.md), as
 *     to an FM-1 on USB: dev_sysex in, dev_sysex_out out; no screen or panel is shown (the UI's code runs, with no
 *     input);
 *   - the flash: a 1 MiB NOR image behind storage.c's hooks (settings and the song order, the sections A..D, the
 *     working project, user presets, the FM6 patch bank, the user sample slots read through it as XIP); the page
 *     keeps its storage sectors as the plugin's state;
 *   - the host's tempo, fractional (core.h SLOOP_TUTTI: the transport clock keeps to its grid over any length);
 *   - a headless render: the device without its main loop (no flash writes), the song (the arranger), a section or
 *     the working pattern started on the first block, or the host's MIDI at frames (use B: the sequencer never
 *     runs), blocks of CTL frames into float mix + each part's own mixacc_t (fx.c tutti_acc) for its stem;
 *   - a part's stem (tutti_stem_render, in an instance of its own: its own buses, see README).
 *   web/plugin/build.sh  ->  build/plugin-wasm/sloop.wasm */
#include <stdint.h>
#include <string.h>

#define SLOOP_TUTTI 1
#define FELUCCA_FLASH 1
#define FELUCCA_OTA 1                    /* usb.c's SysEx frames for editor.c (ota.c, the update itself: not built) */
#define FELUCCA_UAC 0
#define FELUCCA_UART 0
#define FELUCCA_CDC 0
#define FELUCCA_CPU1 0                   /* one core: every render unit here (fx.c cpu1_on 0) */
#define FELUCCA_ARRANGER 1
#ifndef FELUCCA_ID
#define FELUCCA_ID "FM-1_900"
#endif

#define memset felucca_memset
#define memcpy felucca_memcpy
#define memcmp felucca_memcmp
#include "../../firmware/src/libc.c"
#undef memset
#undef memcpy
#undef memcmp
#include "felucca_tables.h"

static uint8_t nor[0x100000];            /* the SPI NOR (erased: 0xFF) */
#define fm1_xip_ptr fm1_xip_ptr_hal      /* (hal/fm1_xip.h, which eng_sample.c includes: the FM-1's address, not here) */
#include "../../firmware/hal/fm1_xip.h"
#undef fm1_xip_ptr
static const uint8_t *fm1_xip_ptr(uint32_t off) { return nor + (off & 0xFFFFFu); }   /* the XIP window: the image */
#define SMP_USER_XIP(k) fm1_xip_ptr(SMP_USER_OFF((uint32_t)(k)))   /* eng_sample.c */

/* ------------------------------------------------------------ the HAL --- */
static struct { volatile uint32_t notes, buttons; } fm1_in;
static volatile uint32_t fm1_remote_btn;
static void fm1_irq_off(void) {}
static void fm1_irq_on(void) {}
static uint32_t irq_save(void) { return 0; }
static void irq_restore(uint32_t f) { (void)f; }
#define FM1_TICKS_PER_US 24u             /* TIMER4: 24 MHz */
static uint32_t dev_ticks;
static uint32_t fm1_ticks(void) { return dev_ticks; }
static void fm1_wdt_feed(void) {}
static void fm1_delay_ms(uint32_t ms) { (void)ms; }

#include "../../firmware/src/core.h"
#include "../../firmware/src/cpu1.h"     /* no second core here: every unit renders on this one */
static int cpu1_run(cpu1_job_t fn, uint32_t arg) { (void)fn; (void)arg; return 0; }
static int cpu1_wait(void) { return 0; }
static int cpu1_on(void) { return 0; }
static uint32_t cpu1_ticks(void) { return 0; }
#include "../../firmware/src/engines.c"
#include "../../firmware/src/drums.c"
#include "../../firmware/src/params.c"
#include "../../firmware/src/voice.c"
#include "../../firmware/src/slicer.c"
#include "../../firmware/src/fx.c"
#include "../../firmware/src/usb.c"
#include "../../firmware/src/arranger.c"
#include "../../firmware/src/seq.c"

/* ----------------------------------------------------- the audio (ALNK0) --- */
static uint8_t fm1_audio_pending(void) { return 1; }
#define FM1_AUDIO_HALF 1u
static void fm1_audio_ack_aux(uint8_t p) { (void)p; }
static uint32_t fm1_audio_free_half(void) { return 0; }
static void fm1_audio_ack_half(void) {}
static void fm1_audio_init(int32_t *buf, uint32_t words, void (*isr)(void), uint32_t prio)
{ (void)buf; (void)words; (void)isr; (void)prio; }
static void fm1_audio_stop(void) {}
void isr_alnk0(void) {}
#include "../../firmware/src/audio.c"

/* ------------------------------------------------- the panel, the screen --- */
static int32_t dev_enc[7];
static int32_t fm1_enc_take(uint32_t e) { int32_t s = dev_enc[e % 7u]; dev_enc[e % 7u] = 0; return s; }
#define FM1_NCOL 16u
static const int8_t FM1_KEYMAP[5][16];
static uint8_t fm1_led[16], fm1_led_dim[16], fm1_led_bg[16];
static volatile uint16_t fm1_led_bg_ns;
static void fm1_led_key(uint32_t id, int on) { (void)id; (void)on; }
static uint32_t fm1_input_edges(int x) { (void)x; return 0; }
static uint32_t fm1_input_note_edges(void) { return 0; }
static void fm1_input_init(void) {}
static int32_t fm1_adc_read(int c) { (void)c; return -1; }
static void fm1_adc_init(void) {}
static uint16_t dev_fb[240 * 240];      /* the screen (RGB565 as the panel gets it): never drawn (no main loop's
                                         * ui_draw here: the page is the editor) */
static void lcd_fill(uint32_t x, uint32_t y, uint32_t w, uint32_t h, uint16_t c)
{
    uint32_t i, j;
    uint16_t sw = (uint16_t)((c >> 8) | (c << 8));
    for (j = 0; j < h && y + j < 240u; j++)
        for (i = 0; i < w && x + i < 240u; i++)
            dev_fb[(y + j) * 240u + x + i] = sw;
}
static void lcd_blit(uint32_t x, uint32_t y, uint32_t w, uint32_t h, const uint16_t *p)
{
    uint32_t i, j;
    for (j = 0; j < h && y + j < 240u; j++)
        for (i = 0; i < w && x + i < 240u; i++)
            dev_fb[(y + j) * 240u + x + i] = p[j * w + i];
}
static void lcd_sync(void) {}
static void lcd_init(void) {}
#define FELUCCA_ICONS 0                  /* (no screen here: the icon atlas, a Felucca Asset, stays out) */
#include "../../firmware/src/gfx.c"
#include "../../firmware/src/panel.c"
#include "../../firmware/src/ui.c"
#include "../../firmware/src/ui_song.c"
#include "../../firmware/src/ui_studio.c"
#include "../../firmware/src/icons.c"
#include "../../firmware/src/ui_draw.c"
#include "../../firmware/src/ui_vis.c"
#include "../../firmware/src/ui_layers.c"
#include "../../firmware/src/ui_menu.c"
#include "../../firmware/src/ui_input.c"

/* ------------------------------------------------------------ the flash --- */
/* where storage.c may write (hal/fm1_flash.h's map) */
#define FL_DATA_LO      0x00097000u                /* the projects, the working project's copy A, the user sample */
#define FL_DATA_HI      0x000E0000u                /* slots USR1..USR3, the user preset banks */
#define FL_GLOB_LO      0x000FC000u                /* the settings (the song order, the SYN kits, the theme), */
#define FL_GLOB_HI      0x000FF000u                /* the working project's copy B */
#define FL_FM6_LO       0x000E5000u                /* the FM6 patch bank */
#define FL_FM6_HI       0x000E7000u
#define FL_USR4_LO      0x000E7000u                /* the user sample slot USR4 */
#define FL_USR4_HI      0x000FB000u
#define FL_IN(off, n, lo, hi) ((uint32_t)(off) >= (lo) && (uint32_t)(off) <= (hi) &&                                (uint32_t)(n) <= (hi) - (uint32_t)(off))
#define FL_STORE_OK(off, n) (FL_IN(off, n, FL_DATA_LO, FL_DATA_HI) || FL_IN(off, n, FL_GLOB_LO, FL_GLOB_HI) ||                              FL_IN(off, n, FL_FM6_LO, FL_FM6_HI) || FL_IN(off, n, FL_USR4_LO, FL_USR4_HI))
static uint8_t flash_ok;
static uint32_t dev_flash_writes;
static uint32_t dev_other_writes;                  /* flash writes outside the projects, the autosave and the settings
                                                    * (user presets, the FM6 bank, the user sample slots): tutti_sig */
static void dev_written(uint32_t off)
{
    dev_flash_writes++;
    if (!(off >= 0x97000u && off < 0xA0000u) && !(off >= 0xFC000u && off < 0xFF000u))
        dev_other_writes++;
}
static int st_read(uint32_t off, void *dst, uint32_t n)
{
    if (off >= sizeof nor || n > sizeof nor - off)
        return -1;
    memcpy(dst, nor + off, n);
    return 0;
}
static int fl_erase4k_quiet(uint32_t off, uint32_t *took)
{
    *took = 0;
    if (off >= sizeof nor || 4096u > sizeof nor - off)
        return -8;
    memset(nor + (off & ~4095u), 0xFF, 4096);
    dev_written(off);
    return 0;
}
static int fl_write(uint32_t off, const void *src, uint32_t n)      /* NOR: a write only clears bits */
{
    const uint8_t *s = src;
    uint32_t i;
    if (off >= sizeof nor || n > sizeof nor - off)
        return -8;
    for (i = 0; i < n; i++)
        nor[off + i] &= s[i];
    dev_written(off);
    return 0;
}
static void fl_inval(uint32_t off, uint32_t n) { (void)off; (void)n; }
static int st_erase(uint32_t off)
{
    uint32_t took;
    if (!FL_STORE_OK(off, 0x1000u))
        return -8;
    return fl_erase4k_quiet(off, &took);
}
static int st_prog(uint32_t off, const void *src, uint32_t n)
{
    if (!FL_STORE_OK(off, n))
        return -8;
    return fl_write(off, src, n);
}
static uint32_t fl_jedec_ram(void) { return 0x856014u; }             /* the FM-1's part (project.c) */
static void fl_plain_window_init(void) {}
#define FL_FAR(fn) (fn)
#define ST_XIP_PTR(off) fm1_xip_ptr(off)
#include "../../firmware/src/storage.c"
#include "../../firmware/src/upreset.c"
#include "../../firmware/src/project.c"
static uint32_t ota_now_ms(void) { return fm1_ms; }
static void dev_drain(void);
static void ota_idle(void) { dev_drain(); }
#include "../../firmware/src/editor.c"
#include "../../firmware/src/splash.c"

/* ------------------------------------------------- main.c and its HAL --- */
typedef struct { uint32_t vec, pc, emu, dbg, rets, sp; } fm1_crash_t;
static struct { uint8_t p3_rst, wdt_con; uint32_t rst_src; } fm1_boot;
uint32_t _data_start[1], _data_end[1], _data_load[1], _bss_start[1], _bss_end[1];
uint32_t _pool_start[1], _pool_end[1], _rt_start[1], _rt_end[1], _rt_load[1];
uint32_t _c1_start[1], _c1_end[1], _c1_load[1], _lr_start[1], _lr_end[1];
char _ustack_lo[1], _ustack_top[1], _sstack_lo[1], _sstack_top[1];
enum { FM1_ADC_BATT = 3, FM1_ADC_MASTER = 4 };
static void fm1_timer5_ack(void) {}
static void fm1_timer5_start(void (*isr)(void), uint32_t prio) { (void)isr; (void)prio; }
void isr_timer5(void) {}
static void fm1_input_tick(void) {}
static void fm1_reboot(void) {}
static void fm1_enter_uboot(void) {}
static void fm1_guard_lock_top(void) {}
static void fm1_irq_enable_all(void) {}
static void fm1_irq_init(void) {}
static void fm1_time_init(void) {}
static void fm1_reset_reason(void) {}
static void fm1_supplies_stock(void) {}
static void fm1_wdt_arm(uint32_t v) { (void)v; }
static void fm1_mailbox_clear(void) {}
static void fm1_guard_enable(uint32_t m) { (void)m; }
static uint32_t fm1_sp(void) { return 0; }
static uint32_t fm1_ssp(void) { return 0; }
static uint32_t fm1_usp(void) { return 0; }
enum { FM1_GUARD_STACK = 1, FM1_GUARD_WRITE = 2, FM1_GUARD_BUS = 4, FM1_GUARD_PC = 8 };
static uint32_t cpu1_state, cpu1_timeouts;      /* (no second core: cpu1.c is not built) */
static void cpu1_boot(void) {}
static void ota_service(void) {}                   /* (no update: ota.c, recovery.c are not built) */
static void ota_session(void) {}
static void ota_boot_cleanup(void) {}
static int recovery_key(void) { return 0; }
static void recovery_main(void) {}
/* main.c's calls into the USB driver (registers): nothing here (usb.c's own functions stay as they are) */
#define usb_poll() ((void)0)
#define usb_start() ((void)0)
#define usb_retry(ms) ((void)(ms))
#define usb_detach() ((void)0)
#include "../../firmware/src/main.c"
#undef usb_poll
#undef usb_start
#undef usb_retry
#undef usb_detach

/* --------------------------------------------------------- the device --- */
#define EXPORT __attribute__((used, visibility("default")))

static uint32_t dev_booted, dev_frames, dev_ms0, dev_last_frame, dev_headless;
static int32_t dev_blk[2u * CTL];

/* main.c fm1_main's boot, up to its loop (no USB driver, UART, splash, panel setup, second core) */
static void dev_power_on(void)
{
    persist_boot();
    settings_init();
    memset(&felucca_dbg, 0, sizeof felucca_dbg);
    felucca_dbg.magic = DBG_MAGIC;
    fm1_input_init();
    fm1_adc_init();
    panel_init();
    felucca_init();
    audio_init();
    usb.config = 1;                                /* the editor's port is open (usb.c ota_wire_send) */
    dev_ms0 = fm1_ms;
    dev_last_frame = fm1_ms;
    dev_booted = 1;
}

/* the SysEx the device sends (usb.c's ring of USB-MIDI packets) as bytes for the page; its MIDI out is dropped */
static uint8_t dev_out[8192];
static uint32_t dev_out_n;
static void dev_drain(void)
{
    static const uint8_t LEN[16] = {0, 0, 0, 0, 3, 1, 2, 3};
    while (so_r != so_w) {
        uint32_t pkt = sx_out_q[so_r % SXQ], k, len = LEN[pkt & 15u];
        so_r++;
        for (k = 0; k < len && dev_out_n < sizeof dev_out; k++)
            dev_out[dev_out_n++] = (uint8_t)(pkt >> (8u + 8u * k));
    }
    mo_r = mo_w;
}

/* one pass of main.c fm1_main's loop (what the browser has: the editor, the input, the saves when quiet; no USB
 * driver, update, UBOOT or master knob: MASTER is the page's) */
static uint32_t dev_knob = 724;                   /* MASTER as the page turns it, 0..1023 as the ADC reads it (~2048) */
static void dev_frame(void)
{
    uint32_t k10 = ed_master ? (ed_master - 1u) * 1023u / 126u : dev_knob;   /* (main.c: the LIVE page's level, until
                                                                              * the knob turns) */
    song.master_q12 = (k10 * k10) >> 8;
    felucca_dbg.ui_frames++;
    ed_service();
    ui_input();
    ui_leds();
    autosave_tick();
    sections_flush();
    dev_drain();
}

/* the device's clock (fm1_ms, TIMER4) to the frames rendered; a main loop pass every 15 ms, its wait loop (the
 * input, the editor's replies) on each millisecond between */
static void dev_clock(void)
{
    while ((uint64_t)(fm1_ms - dev_ms0 + 1u) * FS <= (uint64_t)dev_frames * 1000u) {
        fm1_ms++;
        dev_ticks += 1000u * FM1_TICKS_PER_US;
        if (dev_headless)
            continue;
        if (fm1_ms - dev_last_frame >= 15u) {
            dev_last_frame = fm1_ms;
            dev_frame();
        } else {
            ui_input();
            ed_service();
            dev_drain();
        }
    }
}

/* one block of CTL frames of the device (audio.c audio_block without the USB audio and the scope) */
static float dev_l[CTL], dev_r[CTL];
static void dev_block(void)
{
    uint32_t k;
    dev_clock();
    mix_block(dev_blk, CTL);
    for (k = 0; k < CTL; k++) {
        dev_l[k] = (float)dev_blk[2u * k] / 32768.0f;
        dev_r[k] = (float)dev_blk[2u * k + 1u] / 32768.0f;
    }
    dev_frames += CTL;
}

/* ---- the live device (the page's worklet) */
static float out_l[1024], out_r[1024];
static uint32_t dev_pos = CTL;                      /* frames of dev_l / dev_r already given out */
EXPORT float *dev_out_l(void) { return out_l; }
EXPORT float *dev_out_r(void) { return out_r; }
EXPORT uint32_t dev_sample_rate(void) { return FS; }
/* n frames (<= 1024) into dev_out_l / _r */
EXPORT void dev_render(uint32_t n)
{
    uint32_t i;
    if (n > 1024u)
        n = 1024u;
    for (i = 0; i < n; i++) {
        if (dev_pos >= CTL) {
            dev_block();
            dev_pos = 0;
        }
        out_l[i] = dev_l[dev_pos];
        out_r[i] = dev_r[dev_pos++];
    }
}
/* the editor's SysEx in, one frame F0 .. F7 at a time (usb.c sysex_byte, as from USB): 0 = the device still holds
 * the last one (send it again later), 1 = taken */
static uint8_t dev_in[1024];
EXPORT uint8_t *dev_sysex_in(void) { return dev_in; }
EXPORT uint32_t dev_sysex(uint32_t n)
{
    uint32_t i;
    if (sx_ready)
        return 0;
    for (i = 0; i < n && i < sizeof dev_in; i++)
        sysex_byte(dev_in[i]);
    ed_service();                                  /* (as main.c's wait loop: at once) */
    dev_drain();
    return 1;
}
/* what the device sent since the last dev_sysex_clear: SysEx frames, F0 .. F7 */
EXPORT uint8_t *dev_sysex_out(void) { return dev_out; }
EXPORT uint32_t dev_sysex_out_len(void) { return dev_out_n; }
EXPORT void dev_sysex_clear(void) { dev_out_n = 0; }
/* a channel message from the editor's keys (or Web MIDI), as a USB-MIDI packet arrives (usb.c midi_enqueue) */
EXPORT uint32_t dev_midi(uint32_t status, uint32_t d1, uint32_t d2)
{
    if (status < 0x80u || status >= 0xF0u || mi_w - mi_r >= MQ)
        return 0;
    midi_in_event((status >> 4) | status << 8 | (d1 & 127u) << 16 | (d2 & 127u) << 24);
    return 1;
}
/* the page's volume: MASTER's knob turned to k10 (0..1023), which ends the LIVE page's level (main.c) */
EXPORT void dev_master(uint32_t k10)
{
    dev_knob = k10 > 1023u ? 1023u : k10;
    ed_master = 0;
}
EXPORT uint32_t dev_playing(void) { return song.playing; }
EXPORT uint32_t dev_now_ms(void) { return fm1_ms; }

/* ---- the flash: erased, then the state's sectors (dev_nor), then tutti_boot */
EXPORT uint8_t *dev_nor(void) { return nor; }
EXPORT uint32_t dev_nor_size(void) { return sizeof nor; }
EXPORT void dev_nor_erase(void) { memset(nor, 0xFF, sizeof nor); }

/* ------------------------------------------------------------ the tempo --- */
/* the host's tempo: SLOOP's own range (params.c G_BPM, 40 .. 240), fractional. A runtime value (core.h
 * tutti_bpm_q32): the song's G_BPM (in its projects) stays SLOOP's own, so the host's tempo never changes the state */
#define TUTTI_BPM_MIN 40.0
#define TUTTI_BPM_MAX 240.0
EXPORT double tutti_bpm_min(void) { return TUTTI_BPM_MIN; }
EXPORT double tutti_bpm_max(void) { return TUTTI_BPM_MAX; }
/* 1 = set; 0 = out of the range (nothing changed). 0 bpm: none, G_BPM again */
EXPORT uint32_t tutti_tempo(double bpm)
{
    if (bpm == 0.0) {
        tutti_bpm_q32 = 0;
        return 1;
    }
    if (!(bpm >= TUTTI_BPM_MIN && bpm <= TUTTI_BPM_MAX))
        return 0;
    tutti_bpm_q32 = (uint64_t)(bpm * 4294967296.0 + 0.5);
    return 1;
}

/* ------------------------------------------------------------ the state --- */
/* what is only in RAM into the flash now (project.c persist_flush_now, without its wait for quiet): the sections and
 * the song (the settings), the working project as the autosave (while the song plays: the loop it put aside), the
 * settings with the SYN kits not stored yet. Then the flash's storage sectors are the whole state. 1 = written */
EXPORT uint32_t tutti_snapshot(void)
{
    persist_t p;
    const project_t *w = &autosave_buf;
    if (!flash_ok)
        return 0;
    sections_write();
    if (sec_dirty)
        return 0;
    persist_fill(&p);
    if (dsu_dirty || fav_dirty || memcmp(&p, &persist_saved, sizeof p) || settings_later) {
        settings_later = 0;
        if (settings_write(&p))
            return 0;
        persist_saved = p;
    }
    if (arrangement_clock.running && song_kept)
        w = &song_keep;                               /* (the song plays sections: the loop you made is aside) */
    else
        proj_capture(&autosave_buf);
    if (w->sum != autosave_hash) {
        if (st_save(OBJ_AUTOSAVE, w, sizeof *w))
            return 0;
        autosave_hash = w->sum;
    }
    return 1;
}
/* what the state is (a change: a new revision): the working project, the sections, the settings (the song order,
 * the SYN kits, the MIDI part, the side record), and the flash writes of the rest (user presets, the FM6 bank, the
 * user samples) */
static uint32_t sig_mix(uint32_t h, const void *p, uint32_t n)
{
    const uint8_t *b = p;
    while (n--)
        h = (h ^ *b++) * 16777619u;
    return h;
}
EXPORT uint32_t tutti_sig(void)
{
    static project_t cur;
    persist_t p;
    uint8_t mp[MIDI_PART];
    side_rec_t r;
    uint32_t h = 2166136261u, i, none = 0;
    if (arrangement_clock.running && song_kept)
        cur = song_keep;
    else
        proj_capture(&cur);
    h = sig_mix(h, &cur.sum, 4);
    for (i = 0; i < 4u; i++)
        h = sig_mix(h, proj_ok(&proj_slot[i]) ? &proj_slot[i].sum : &none, 4);
    persist_fill(&p);
    h = sig_mix(h, &p, sizeof p);
    midi_part_fill(mp);
    h = sig_mix(h, mp, sizeof mp);
    h = sig_mix(h, &dsu, sizeof dsu);
    memset(&r, 0, sizeof r);
    side_fill(&r);
    h = sig_mix(h, &r, sizeof r);
    return sig_mix(h, &dev_other_writes, 4);
}

/* ------------------------------------------------------- the render --- */
/* power on, for the host: headless (a render) the main loop never runs (no flash writes, no editor); MASTER at its
 * top (the render's level; the live page keeps its own), SYNC and CLK OUT off (no external clock: the host's tempo),
 * no click, no recording, no count-in */
EXPORT void tutti_boot(uint32_t headless)
{
    dev_headless = headless;
    dev_power_on();
    if (headless) {
        song.master_q12 = 4096;
        song.g[G_SYNC] = 0;
        song.g[G_CLKOUT] = 0;
        song.g[G_CLOCK] = 0;                          /* (the click: never in a render) */
        song.rec = 0;
        rec_wait = 0;
        rec_count = 0;
        drum_mute = 0;
        mix_block(dev_blk, CTL);                      /* (a silent block first: what the power-on asked for, the panic of
                                                       * every track among it, done before frame 0, so a note there sounds) */
    }
}

/* what plays from the transport's start: 0 the song (the arranger: SONG's order of the sections A..D; with none
 * valid, the working pattern), 1 the working pattern (loop), 2 + s section s (loop). -> what will play (0, 1, 2 + s) */
EXPORT uint32_t tutti_mode(uint32_t mode)
{
    arrangement_enabled = 0;
    if (mode == 0u) {
        if (arr_valid(&arrangement, arrangement_ready())) {
            arrangement_enabled = 1;
            return 0;
        }
        return 1;
    }
    if (mode >= 2u && mode < 6u) {
        if (!proj_ok(&proj_slot[mode - 2u]))
            return 1;
        section_load(mode - 2u);
        transport_req = 0;                            /* (project_apply stops the transport: it is stopped) */
        return mode;
    }
    return 1;
}
/* the song's length in bars (the arranger's entries, in order), 0 when there is no valid song */
EXPORT uint32_t tutti_song_bars(void)
{
    uint32_t i, bars = 0;
    if (!arr_valid(&arrangement, arrangement_ready()))
        return 0;
    for (i = 0; i < arrangement.count; i++)
        bars += arrangement.entry[i].bars;
    return bars;
}

/* the transport from the next block (frame 0 of the render: step 0 of every track there); stopped with the block
 * nearest to frame `stop` (toBeat: the notes let go there, the tail only rings out; ~0u: never) */
static uint32_t tt_stop = ~0u;
EXPORT void tutti_start(uint32_t stop)
{
    transport_req = 1;
    tt_stop = stop;
}

/* use B: MIDI events at frames from frame 0, in time order, each played with the block whose start is nearest (the
 * firmware's control rate is a block of CTL frames: within CTL / 2). The sequencer never runs: a channel plays its
 * part straight (as firmware/host/preview.c preview_note): MIDI channels 0..2 the synth parts 1..3 (the notes as the
 * keys play them: arp, chords, KBD HOLD and the pedal as set), 3 the drum track (a GM note: its lane's sound, as
 * MIDI IN maps it (drums.c lane_of_note), through voice.c trk_note_on and drums.c drum_on at the note's velocity, not
 * MIDI IN's four levels); CC (64 the pedal; the SLOOP CC map, seq.c midi_cc) and pitch bend on those channels too;
 * other channels are ignored */
#define TT_NEV 65536u
static struct { uint32_t frame; uint8_t st, d1, d2; } tt_ev[TT_NEV];
static uint32_t tt_nev, tt_evr;
EXPORT uint32_t tutti_event(uint32_t frame, uint32_t status, uint32_t d1, uint32_t d2)
{
    if (tt_nev >= TT_NEV || status < 0x80u || status >= 0xF0u)
        return 0;
    tt_ev[tt_nev].frame = frame;
    tt_ev[tt_nev].st = (uint8_t)status;
    tt_ev[tt_nev].d1 = (uint8_t)(d1 & 127u);
    tt_ev[tt_nev].d2 = (uint8_t)(d2 & 127u);
    tt_nev++;
    return 1;
}
static void tt_play(uint32_t st, uint32_t d1, uint32_t d2)
{
    uint32_t ch = st & 15u, type = st & 0xF0u;
    track_t *t;
    if (ch > TRK_DRUM)
        return;
    t = &trk[ch];
    if (type == 0x90u && d2) {
        if (ch == TRK_DRUM)
            trk_note_on(t, LANE_NOTE[lane_of_note(d1)], d2);   /* (its lane's sound, as MIDI IN takes a GM note) */
        else
            input_on(t, d1, d2);
    } else if (type == 0x80u || type == 0x90u) {
        if (ch != TRK_DRUM)
            input_off(t, d1);
    } else if (type == 0xB0u) {
        if (d1 == 0u)
            return;                                   /* (Bank Select: no Program Change comes) */
        if (d1 == 64u)
            midi_pedal(ch, t, d2);
        midi_cc(t, d1, d2);
    } else if (type == 0xE0u && ch != TRK_DRUM) {
        midi_bend(ch, t, d1, d2);
    }
}
static void tt_events(uint32_t f0)
{
    while (tt_evr < tt_nev && tt_ev[tt_evr].frame < f0 + CTL / 2u) {
        tt_play(tt_ev[tt_evr].st, tt_ev[tt_evr].d1, tt_ev[tt_evr].d2);
        tt_evr++;
    }
}

#define TT_MAXB 128u                       /* blocks a call renders at most (4096 frames) */
static float tt_l[TT_MAXB * CTL], tt_r[TT_MAXB * CTL];
static int32_t tt_cap[NPART + 1u][TT_MAXB][6][CTL];   /* each unit's l r sc sd sr (fx.c tutti_acc) per block of a
                                                        * call, and the limiter's gain (fx.c tutti_lim) */
/* nblocks (<= TT_MAXB) blocks of CTL frames into tutti_out_l / _r (the mix: the master output, the limiter's CTL
 * frames of look-ahead in it, see tutti_latency); capture: the units' sums too (tutti_cap) */
EXPORT void tutti_render(uint32_t nblocks, uint32_t capture)
{
    uint32_t b, k, u;
    if (nblocks > TT_MAXB)
        nblocks = TT_MAXB;
    for (b = 0; b < nblocks; b++) {
        uint32_t f0 = dev_frames;
        tt_events(f0);
        if (tt_stop != ~0u && f0 + CTL / 2u > tt_stop) {
            transport_req = 2;                        /* (seq.c events_block: seq_stop, before the steps) */
            tt_stop = ~0u;
        }
        dev_block();
        for (k = 0; k < CTL; k++) {
            tt_l[b * CTL + k] = dev_l[k];
            tt_r[b * CTL + k] = dev_r[k];
        }
        if (capture)
            for (u = 0; u <= NPART; u++) {
                memcpy(tt_cap[u][b][0], tutti_acc[u].l, sizeof tutti_acc[u].l);
                memcpy(tt_cap[u][b][1], tutti_acc[u].r, sizeof tutti_acc[u].r);
                memcpy(tt_cap[u][b][2], tutti_acc[u].sc, sizeof tutti_acc[u].sc);
                memcpy(tt_cap[u][b][3], tutti_acc[u].sd, sizeof tutti_acc[u].sd);
                memcpy(tt_cap[u][b][4], tutti_acc[u].sr, sizeof tutti_acc[u].sr);
                memcpy(tt_cap[u][b][5], tutti_lim, sizeof tutti_lim);
            }
    }
}
EXPORT float *tutti_out_l(void) { return tt_l; }
EXPORT float *tutti_out_r(void) { return tt_r; }
EXPORT int32_t *tutti_cap(uint32_t u) { return &tt_cap[u % (NPART + 1u)][0][0][0]; }
EXPORT uint32_t tutti_block_frames(void) { return CTL; }
EXPORT uint32_t tutti_max_blocks(void) { return TT_MAXB; }
EXPORT int16_t *tutti_song_g(void) { return song.g; }
/* frames from an event to its sound at the output: the master limiter's look-ahead (fx.c lim_block, a block). A step
 * or a MIDI note sounds in the block it is taken in (the firmware takes them per block: within CTL frames of their
 * time, see tt_events and README) */
EXPORT uint32_t tutti_latency(void) { return CTL; }
/* the transport clock, for the tests: beats since PLAY and units into the beat at the next block's start */
EXPORT uint32_t tutti_clk_beat(void) { return clk_beat; }
EXPORT uint32_t tutti_clk_pos(void) { return clk_pos; }
EXPORT uint32_t tutti_playing(void) { return song.playing; }
EXPORT uint32_t tutti_song_running(void) { return arrangement_clock.running; }

/* ------------------------------------------------------------ a stem --- */
/* In an instance of its own (booted with the same state, the same tempo; song.g copied in from the render's before
 * each call): one unit's sums (tt_cap's layout, copied into tutti_bus_in) through this instance's buses (fx.c
 * fx_buses: its own chorus, delay and reverb, fed by this unit's sends only), added to the unit's dry mix, through
 * the master filter (its own state), at MASTER's level, the DC blocker and LOW CUT (master_pre, its own state), a
 * block late as the limiter's look-ahead makes the mix, then at the mix's limiter gain of that sample (the mix's, not
 * its own: the stems are as loud as the units are in the limited mix); not DUST, TEXTURE, the punch-in FX or the
 * output knee (see README) */
static int32_t tt_bus[TT_MAXB][6][CTL];
static float tt_sl[TT_MAXB * CTL], tt_sr[TT_MAXB * CTL];
static int32_t tt_dl[CTL], tt_dr[CTL];             /* the look-ahead's block */
EXPORT int32_t *tutti_bus_in(void) { return &tt_bus[0][0][0]; }
EXPORT float *tutti_stem_l(void) { return tt_sl; }
EXPORT float *tutti_stem_r(void) { return tt_sr; }
EXPORT void tutti_stem_render(uint32_t nblocks)
{
    static int32_t wl[CTL], wr[CTL], l[CTL], r[CTL];
    uint32_t b, i;
    if (nblocks > TT_MAXB)
        nblocks = TT_MAXB;
    for (b = 0; b < nblocks; b++) {
        int32_t (*s)[CTL] = tt_bus[b];
        fx_buses(s[2], s[3], s[4], wl, wr, CTL);
        for (i = 0; i < CTL; i++) {
            l[i] = s[0][i] + wl[i];
            r[i] = s[1][i] + wr[i];
        }
        djf_process(l, r, CTL);
        for (i = 0; i < CTL; i++) {
            int32_t m = (int32_t)song.master_q12, xl, xr, g = s[5][i];
            int32_t ol = ((l[i] >> 2) * m) >> 10, orr = ((r[i] >> 2) * m) >> 10;
            master_pre(&ol, &orr);
            xl = tt_dl[i], xr = tt_dr[i];
            tt_dl[i] = ol, tt_dr[i] = orr;
            if (g < 32768) {
                xl = (int32_t)(((int64_t)xl * g) >> 15);
                xr = (int32_t)(((int64_t)xr * g) >> 15);
            }
            tt_sl[b * CTL + i] = (float)xl / 32768.0f;
            tt_sr[b * CTL + i] = (float)xr / 32768.0f;
        }
    }
}

/* ------------------------------------------------- the live page's seek --- */
/* the transport for the page's preview of the host's (listen-only): stopped, or playing from `frames` after the
 * start: the sequencer started and run on that far without sound (events_block: its steps, the song's sections, as
 * playing them would), then what it started let go, so the music goes on from there. tutti_seek only starts it;
 * tutti_seek_run runs it a bounded number of blocks per call (the worklet: per render quantum, silent until it is
 * done), so a seek minutes into a song never stalls the audio thread */
static uint32_t tt_seek, tt_seeking;               /* blocks still to run; a seek is on */
EXPORT void tutti_seek(uint32_t play, uint32_t frames)
{
    if (song.playing)
        seq_stop();
    transport_req = 0;
    tt_seek = tt_seeking = 0;
    if (!play)
        return;
    song.rec = 0;
    rec_wait = 0;
    seq_start();
    tt_seek = frames / CTL;
    tt_seeking = 1;
}
EXPORT uint32_t tutti_seek_run(uint32_t max, uint32_t more)
{
    uint32_t i, k;
    if (!tt_seeking)
        return 0;
    tt_seek += more;
    for (; tt_seek && max; tt_seek--, max--)
        events_block(CTL);
    if (tt_seek)
        return tt_seek;
    tt_seeking = 0;
    for (i = 0; i < NPART; i++)
        for (k = 0; k < NVOICE; k++)
            if (trk[i].v[k].active)
                voice_kill(&trk[i].v[k]);
    return 0;
}
/* which the live device plays from PLAY: the song (1: SONG's order, when it is valid) or the loop (0) */
EXPORT void tutti_live_song(uint32_t on) { arrangement_enabled = (uint8_t)(on && arr_valid(&arrangement, arrangement_ready())); }

/* ---- for the tests (web/plugin/plugin_test.mjs) */
EXPORT uint32_t tutti_test_proj_ok(uint32_t s) { return proj_ok(&proj_slot[s & 3u]); }
/* what one pass of what `mode` plays takes, in beats (tutti_mode's modes; nothing changes): the song's bars when it
 * is valid (once through, if it loops), else the longest track of the working pattern or of the section (project.c
 * section_bars) -- the range of "Render to tuttidaw" */
EXPORT uint32_t tutti_play_beats(uint32_t mode)
{
    uint32_t k, bars = 1;
    if (mode == 0u && tutti_song_bars())
        return 4u * tutti_song_bars();
    if (mode >= 2u && mode < 6u && proj_ok(&proj_slot[mode - 2u]))
        return 4u * section_bars(mode - 2u);
    for (k = 0; k < NTRK; k++) {
        uint32_t len = (uint32_t)clamp(trk[k].p[P_SLEN], 1, NSTEP), u = div_units((uint32_t)trk[k].p[P_SDIV] % NDIV_STEP);
        uint32_t b = (len * u + 4u * BEAT_U - 1u) / (4u * BEAT_U);
        if (b > bars)
            bars = b;
    }
    return 4u * (bars > 64u ? 64u : bars);
}
