package main

import (
	"golang.org/x/sys/windows"
	"os"
	"unsafe"
)

// Match launch.bat's color 0A for direct executable/shortcut launches too.
// Native console calls add no escape codes to redirected output and do not
// create, hide, clear or resize a window. Ignore unsupported terminal APIs.
func setupConsolePresentation() func() {
	handle := windows.Handle(os.Stdout.Fd())
	var mode uint32
	if windows.GetConsoleMode(handle, &mode) != nil {
		return func() {}
	}
	kernel := windows.NewLazySystemDLL("kernel32.dll")
	color := kernel.NewProc("SetConsoleTextAttribute")
	title := kernel.NewProc("SetConsoleTitleW")
	getTitle := kernel.NewProc("GetConsoleTitleW")
	var info windows.ConsoleScreenBufferInfo
	haveInfo := windows.GetConsoleScreenBufferInfo(handle, &info) == nil
	oldTitle := make([]uint16, 32768)
	n, _, _ := getTitle.Call(uintptr(unsafe.Pointer(&oldTitle[0])), uintptr(len(oldTitle)))
	text, _ := windows.UTF16PtrFromString("GobboNet - Local AI Chat [llama.cpp]")
	color.Call(uintptr(handle), 0x0A)
	title.Call(uintptr(unsafe.Pointer(text)))
	return func() {
		if haveInfo {
			color.Call(uintptr(handle), uintptr(info.Attributes))
		}
		if n > 0 && n < uintptr(len(oldTitle)) {
			title.Call(uintptr(unsafe.Pointer(&oldTitle[0])))
		}
	}
}
