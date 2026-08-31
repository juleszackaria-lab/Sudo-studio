' launch_hidden.vbs - Sudo Studio v5.0
' Launches an executable completely hidden (no window, no taskbar icon).
' Usage: cscript //nologo launch_hidden.vbs "C:\path\to\app.exe" [args...]
' The "0" parameter = SW_HIDE (invisible window).
' The "False" parameter = do not wait for process to finish (fire-and-forget).

If WScript.Arguments.Count = 0 Then
    WScript.Echo "Usage: cscript //nologo launch_hidden.vbs ""path\to\app.exe"" [args]"
    WScript.Quit 1
End If

Dim objShell
Dim cmdLine
Dim i

Set objShell = CreateObject("WScript.Shell")

' Build command line: first arg is the executable, rest are arguments
cmdLine = Chr(34) & WScript.Arguments(0) & Chr(34)
For i = 1 To WScript.Arguments.Count - 1
    cmdLine = cmdLine & " " & WScript.Arguments(i)
Next

' 0 = SW_HIDE (no window), False = do not wait
objShell.Run cmdLine, 0, False

Set objShell = Nothing
