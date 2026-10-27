using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Visible GUI host survives Electron exit. Closing while installing minimizes it.
internal static class UpdateLauncher {
 [STAThread] private static int Main(string[] args) {
  if(args.Length!=1)return 2;
  string job=Path.GetFullPath(args[0]),directory=Path.GetDirectoryName(job);
  try {
   if(Path.GetFileName(job)!="job.json"||!File.Exists(Path.Combine(directory,"install.ps1")))return 2;
   var data=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(job));
   string token=Convert.ToString(data["token"]);Guid parsed;if(!Guid.TryParse(token,out parsed))return 2;
   bool created;
   using(var mutex=new Mutex(true,"Local\\EllenInstall-"+token,out created))
   using(var bring=new EventWaitHandle(false,EventResetMode.AutoReset,"Local\\EllenInstallShow-"+token)) {
    if(!created){bring.Set();return 0;}
    // Completed transactions are evidence, never commands to run again.
    if(File.Exists(Path.Combine(directory,"result.json")))return 0;
    Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
    using(var form=new InstallProgress(job,token,bring)){Application.Run(form);return form.ExitCode;}
   }
  }catch(Exception error){
   try{File.WriteAllText(Path.Combine(directory,"launcher-error.txt"),error.Message);}catch{}
   MessageBox.Show("更新未能开始，请重新打开艾莲查看提示。","艾莲 · 更新未完成",MessageBoxButtons.OK,MessageBoxIcon.Error);return 1;
  }
 }
}
internal sealed class InstallProgress:Form {
 [DllImport("user32.dll")]static extern bool ShowWindow(IntPtr window,int command);
 readonly string job,directory,token;readonly EventWaitHandle bring;
 readonly JavaScriptSerializer json=new JavaScriptSerializer();
 readonly System.Windows.Forms.Timer timer=new System.Windows.Forms.Timer();
 readonly Label title=new Label(),message=new Label(),count=new Label(),hint=new Label();
 readonly ProgressBar bar=new ProgressBar();readonly Button close=new Button();
 readonly object logGate=new object();Process child;StreamWriter output;bool finished;
 DateTime heartbeat=DateTime.MinValue;public int ExitCode{get;private set;}
 public InstallProgress(string jobPath,string transactionToken,EventWaitHandle showEvent){
  job=jobPath;directory=Path.GetDirectoryName(job);token=transactionToken;bring=showEvent;
  Text="艾莲 · 正在安装更新";ClientSize=new Size(520,262);FormBorderStyle=FormBorderStyle.FixedSingle;
  MaximizeBox=false;StartPosition=FormStartPosition.CenterScreen;BackColor=Color.FromArgb(20,24,32);ForeColor=Color.FromArgb(237,241,248);
  Font=new Font("Microsoft YaHei UI",10F);AutoScaleMode=AutoScaleMode.Dpi;
  title.Text="正在更新艾莲";title.Font=new Font(Font.FontFamily,16F,FontStyle.Bold);title.SetBounds(30,25,455,34);
  message.Text="正在等待软件保存并退出…";message.SetBounds(32,77,450,48);
  bar.SetBounds(32,133,456,10);bar.Style=ProgressBarStyle.Marquee;bar.MarqueeAnimationSpeed=28;
  count.SetBounds(32,152,456,24);count.ForeColor=Color.FromArgb(165,178,199);
  hint.Text="安装完成后会自动打开，请勿关闭电脑。";hint.SetBounds(32,187,456,40);hint.ForeColor=Color.FromArgb(155,167,185);
  close.Text="关闭";close.SetBounds(396,212,92,32);close.Visible=false;close.Click+=(s,e)=>Close();
  Controls.AddRange(new Control[]{title,message,bar,count,hint,close});
  FormClosing+=(s,e)=>{if(!finished){e.Cancel=true;WindowState=FormWindowState.Minimized;}};
  timer.Interval=200;timer.Tick+=Tick;
  // The parent suppresses console flashes with STARTF_USESHOWWINDOW/SW_HIDE.
  // A second explicit show must override that inherited first-show instruction.
  Shown+=(s,e)=>BeginInvoke((MethodInvoker)(()=>{ShowWindow(Handle,1);Activate();BeginInstall();}));
 }
 void WriteActive(bool running){
  var data=new Dictionary<string,object>{{"token",token},{"pid",Process.GetCurrentProcess().Id},{"running",running},{"heartbeat",DateTime.UtcNow.ToString("o")}};
  string file=Path.Combine(directory,"active.json"),temp=file+".tmp";
  try{File.WriteAllText(temp,json.Serialize(data),new UTF8Encoding(false));if(File.Exists(file))File.Replace(temp,file,null);else File.Move(temp,file);}catch{}
 }
 void Receive(object sender,DataReceivedEventArgs e){if(e.Data!=null)lock(logGate){if(output!=null){output.WriteLine(e.Data);output.Flush();}}}
 void BeginInstall(){
  try{
   WriteActive(true);output=new StreamWriter(Path.Combine(directory,"helper-output.log"),true,new UTF8Encoding(false));
   child=new Process{StartInfo=new ProcessStartInfo{
    FileName=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"WindowsPowerShell\\v1.0\\powershell.exe"),
    Arguments="-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \""+Path.Combine(directory,"install.ps1")+"\" -JobFile \""+job+"\"",
    WorkingDirectory=directory,UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden,RedirectStandardOutput=true,RedirectStandardError=true}};
   child.OutputDataReceived+=Receive;child.ErrorDataReceived+=Receive;child.Start();child.BeginOutputReadLine();child.BeginErrorReadLine();timer.Start();
  }catch(Exception error){File.WriteAllText(Path.Combine(directory,"launcher-error.txt"),error.Message);Fail("安装程序未能开始，请重新打开艾莲重试。");}
 }
 Dictionary<string,object> Read(string name){try{return json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(directory,name)));}catch{return null;}}
 void Tick(object sender,EventArgs e){
  if(bring.WaitOne(0)){WindowState=FormWindowState.Normal;ShowWindow(Handle,1);Activate();}
  if(finished)return;
  if((DateTime.UtcNow-heartbeat).TotalSeconds>=1){WriteActive(true);heartbeat=DateTime.UtcNow;}
  var state=Read("journal.json");
  if(state!=null&&Convert.ToString(state["token"])==token){
   string phase=Convert.ToString(state["phase"]);message.Text=Convert.ToString(state["message"]);object doneValue,totalValue;
   if(phase=="staging"&&state.TryGetValue("completed",out doneValue)&&state.TryGetValue("total",out totalValue)&&Convert.ToDouble(totalValue)>0){
    double done=Convert.ToDouble(doneValue),total=Convert.ToDouble(totalValue);bar.Style=ProgressBarStyle.Continuous;
    bar.Value=Math.Max(0,Math.Min(100,(int)(done*100/total)));count.Text="已准备 "+done.ToString("N0")+" / "+total.ToString("N0")+" 个文件";
   }else{bar.Style=ProgressBarStyle.Marquee;count.Text=phase=="starting"?"正在等待新版打开…":"";}
  }
  if(child==null||!child.HasExited)return;
  child.WaitForExit();lock(logGate){if(output!=null){output.Dispose();output=null;}}
  var result=Read("result.json");
  if(child.ExitCode==0&&result!=null&&result.ContainsKey("ok")&&Convert.ToBoolean(result["ok"])){
   finished=true;ExitCode=0;WriteActive(false);timer.Stop();Close();
  }else{
   if(result==null)File.WriteAllText(Path.Combine(directory,"launcher-error.txt"),"Installer exited without a result. Exit code: "+child.ExitCode);
   Fail(result!=null&&result.ContainsKey("message")?Convert.ToString(result["message"]):"安装程序意外结束。请重新打开艾莲查看提示。");
  }
 }
 void Fail(string detail){
  finished=true;ExitCode=1;WriteActive(false);Text="艾莲 · 更新未完成";title.Text="更新未完成";message.Text=detail;
  bar.Style=ProgressBarStyle.Continuous;bar.Value=0;count.Text="已下载的更新文件会保留。";
  hint.Text="关闭此窗口后，可在艾莲中查看并重试。";close.Visible=true;WindowState=FormWindowState.Normal;Activate();
 }
 protected override void Dispose(bool disposing){if(disposing){timer.Dispose();if(child!=null)child.Dispose();lock(logGate){if(output!=null)output.Dispose();}}base.Dispose(disposing);}
}
