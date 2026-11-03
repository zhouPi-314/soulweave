; SoulWeave 卸载钩子（用户决定：默认保留，询问后删除）
;
; electron-builder 的 NSIS 默认会删安装目录、保留 %APPDATA%。
; 这里加一次询问：记忆数据（数据库 + 相册 + 角色）在 %APPDATA%\SoulWeave 下。
!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除 SoulWeave 的记忆数据？$\r$\n$\r$\n包括：数据库、相册、角色与聊天记录。$\r$\n选择「否」会保留这些数据，重新安装后可继续使用。" /SD IDNO IDNO keepData
    RMDir /r "$APPDATA\SoulWeave"
  keepData:
!macroend
