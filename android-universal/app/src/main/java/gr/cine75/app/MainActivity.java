package gr.cine75.app;

import android.app.*;
import android.app.job.*;
import android.content.*;
import android.content.res.Configuration;
import android.graphics.*;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.*;
import android.text.*;
import android.view.*;
import android.view.inputmethod.EditorInfo;
import android.widget.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.*;
import java.util.concurrent.*;
import java.util.zip.GZIPInputStream;
import org.json.*;

public class MainActivity extends Activity {
    static final String HIGH_URL="https://raw.githubusercontent.com/chrispapaioan-rgb/greece-cinema-12m-stremio/main/data/cine75-app-catalog.b64";
    static final String LIVE_URL="https://greece-cinema-12m-stremio.onrender.com/catalog.json";
    static final String TV_BRO="com.phlox.tvwebbrowser";
    static final int BG=Color.rgb(15,23,42), PANEL=Color.rgb(30,41,59), TEXT=Color.WHITE, MUTED=Color.rgb(203,213,225), ACCENT=Color.rgb(37,99,235);
    static final ExecutorService IO=Executors.newFixedThreadPool(4);
    final ArrayList<Movie> movies=new ArrayList<>(), shown=new ArrayList<>();
    SharedPreferences prefs;
    GridView grid;
    MovieAdapter adapter;
    EditText search;
    TextView status;
    LinearLayout categoryBar;
    boolean listMode=false, isTv=false;
    String filter="Όλες";

    static final String[] FILTERS={
        "Όλες","Νέες προσθήκες","80+","75–79.9","Επανακυκλοφορίες","GreekSubsMovies",
        "Αγαπημένα","Watchlist","Δεν έχω δει",
        "Κοινωνικές","Ερωτικές / Ρομαντικές","Κωμωδίες","Δράμα","Θρίλερ","Sci‑Fi","Δράση","Μυστήριο",
        "Εγκλήματος / Αστυνομικές","Τρόμου","Περιπέτεια","Animation","Ντοκιμαντέρ","Ιστορικές","Βιογραφικές","Fantasy","Μουσικές"
    };

    @Override public void onCreate(Bundle b){
        super.onCreate(b);
        isTv=(getResources().getConfiguration().uiMode & Configuration.UI_MODE_TYPE_MASK)==Configuration.UI_MODE_TYPE_TELEVISION;
        prefs=getSharedPreferences("cine75_user",MODE_PRIVATE);
        buildUi();
        loadCache();
        applyFilter();
        scheduleSync(this);
        syncNow(false);
    }

    void buildUi(){
        LinearLayout root=new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(dp(12),dp(10),dp(12),dp(8)); root.setBackgroundColor(BG);
        LinearLayout top=new LinearLayout(this); top.setGravity(Gravity.CENTER_VERTICAL);
        TextView title=t("Cine75",isTv?30:26,TEXT,true); top.addView(title,new LinearLayout.LayoutParams(0,dp(54),1));
        Button mode=btn("☷ Λίστα"); top.addView(mode); mode.setOnClickListener(v->{listMode=!listMode; mode.setText(listMode?"▦ Κάρτες":"☷ Λίστα"); configureGrid(); applyFilter();});
        Button sync=btn("↻"); top.addView(sync); sync.setOnClickListener(v->syncNow(true));
        root.addView(top);

        search=new EditText(this); search.setHint("Αναζήτηση τίτλου, σκηνοθέτη ή ηθοποιού…"); search.setHintTextColor(Color.rgb(148,163,184)); search.setTextColor(TEXT); search.setSingleLine(true);
        search.setImeOptions(EditorInfo.IME_ACTION_SEARCH); search.setBackgroundColor(PANEL); search.setPadding(dp(14),0,dp(14),0);
        root.addView(search,new LinearLayout.LayoutParams(-1,dp(isTv?52:48)));
        search.addTextChangedListener(new TextWatcher(){public void beforeTextChanged(CharSequence s,int a,int c,int d){} public void onTextChanged(CharSequence s,int a,int b,int c){applyFilter();} public void afterTextChanged(Editable e){}});

        HorizontalScrollView hsv=new HorizontalScrollView(this); hsv.setHorizontalScrollBarEnabled(false); categoryBar=new LinearLayout(this); categoryBar.setOrientation(LinearLayout.HORIZONTAL); categoryBar.setPadding(0,dp(8),0,dp(8)); hsv.addView(categoryBar);
        for(String f:FILTERS){Button c=btn(f); c.setTag(f); c.setOnClickListener(v->{filter=(String)v.getTag(); paintFilters(); applyFilter();}); categoryBar.addView(c,new LinearLayout.LayoutParams(-2,dp(isTv?48:42)));}
        root.addView(hsv);

        status=t("Φόρτωση καταλόγου…",14,MUTED,false); root.addView(status,new LinearLayout.LayoutParams(-1,dp(30)));
        grid=new GridView(this); grid.setHorizontalSpacing(dp(10)); grid.setVerticalSpacing(dp(10)); grid.setStretchMode(GridView.STRETCH_COLUMN_WIDTH); grid.setSelector(new ColorDrawable(Color.rgb(51,65,85))); grid.setFocusable(true);
        root.addView(grid,new LinearLayout.LayoutParams(-1,0,1));
        adapter=new MovieAdapter(); grid.setAdapter(adapter); grid.setOnItemClickListener((p,v,pos,id)->showDetails(shown.get(pos)));
        configureGrid(); paintFilters(); setContentView(root);
    }

    void configureGrid(){
        if(listMode){grid.setNumColumns(1); grid.setColumnWidth(GridView.AUTO_FIT);}
        else {grid.setNumColumns(isTv?5:2); grid.setColumnWidth(dp(isTv?190:160));}
        if(adapter!=null)adapter.notifyDataSetChanged();
    }

    void paintFilters(){
        for(int i=0;i<categoryBar.getChildCount();i++){View v=categoryBar.getChildAt(i); if(v instanceof Button){Button b=(Button)v; boolean on=Objects.equals(b.getTag(),filter); b.setTextColor(Color.WHITE); b.setBackgroundColor(on?ACCENT:PANEL);}}
    }

    void loadCache(){
        File f=new File(getFilesDir(),"catalog_cache.json");
        if(f.exists()){
            try{JSONObject root=new JSONObject(read(new FileInputStream(f))); setMovies(parseMovies(root)); status.setText("Offline cache • συγχρονισμός…"); return;}catch(Exception ignored){}
        }
        try{
            String packed=read(getAssets().open("movies_seed.b64"));
            JSONObject root=new JSONObject(gunzipBase64(packed));
            setMovies(parseMovies(root));
            status.setText("Ενσωματωμένος κατάλογος • συγχρονισμός…");
        }catch(Exception ignored){}
    }

    void syncNow(boolean manual){
        status.setText(manual?"Συγχρονισμός…":"Έλεγχος ενημερώσεων…");
        IO.execute(()->{
            try{
                ArrayList<Movie> fresh=downloadCatalog();
                saveCache(fresh);
                runOnUiThread(()->{setMovies(fresh); applyFilter(); status.setText(fresh.size()+" ταινίες ≥75 • ενημερώθηκε τώρα");});
            }catch(Exception e){
                runOnUiThread(()->status.setText((movies.isEmpty()?"Αδυναμία φόρτωσης":"Offline • τελευταίος αποθηκευμένος κατάλογος")+" • "+e.getClass().getSimpleName()));
            }
        });
    }

    static ArrayList<Movie> downloadCatalog() throws Exception{
        String packed=fetch(HIGH_URL);
        JSONObject high=new JSONObject(gunzipBase64(packed));
        ArrayList<Movie> all=parseMovies(high);
        HashMap<String,Movie> map=new HashMap<>();
        for(Movie m:all)map.put(key(m.title,m.year),m);
        try{
            JSONObject live=new JSONObject(fetch(LIVE_URL)); JSONArray a=live.optJSONArray("items");
            if(a!=null)for(int i=0;i<a.length();i++){
                JSONObject x=a.optJSONObject(i); if(x==null)continue;
                int year=x.optInt("year"); String n=x.optString("name"),o=x.optString("originalName");
                Movie m=findMatch(map,n,o,year); if(m==null)continue;
                if(!n.trim().isEmpty()&&!norm(n).equals(norm(m.title)))m.greekTitle=n;
                if(!x.optString("poster").trim().isEmpty())m.poster=x.optString("poster");
                if(!x.optString("background").trim().isEmpty())m.background=x.optString("background");
                String ov=x.optString("overview"); if(!ov.trim().isEmpty())m.description=ov;
                JSONArray gs=x.optJSONArray("genres"); if(gs!=null&&gs.length()>0)m.genres=strings(gs);
                JSONArray cs=x.optJSONArray("cast"); if(cs!=null&&cs.length()>0)m.cast=strings(cs);
                JSONArray ds=x.optJSONArray("director"); if(ds!=null&&ds.length()>0)m.director=String.join(", ",strings(ds));
                int rt=x.optInt("runtime",-1); if(rt>0)m.runtime=rt;
                m.greekDate=x.optString("greekTheatricalDate"); m.rerelease=x.optBoolean("isRerelease",false);
                m.source=(m.source==null?"":m.source)+(m.source==null||m.source.trim().isEmpty()?"":" + ")+"Greek live catalog";
            }
        }catch(Exception ignored){}
        all.removeIf(m->m.score<75); all.sort(Movie.ORDER); return all;
    }

    static Movie findMatch(Map<String,Movie> map,String a,String b,int year){
        Movie m=map.get(key(b,year)); if(m==null)m=map.get(key(a,year)); if(m!=null)return m;
        String na=norm(a),nb=norm(b);
        for(Movie x:map.values()){if(Math.abs(x.year-year)>1)continue;String nt=norm(x.title),ng=norm(x.greekTitle);if((!na.trim().isEmpty()&&(na.equals(nt)||na.equals(ng)))||(!nb.trim().isEmpty()&&(nb.equals(nt)||nb.equals(ng))))return x;} return null;
    }

    static ArrayList<Movie> parseMovies(JSONObject root){
        ArrayList<Movie> out=new ArrayList<>(); JSONArray a=root.optJSONArray("movies"); if(a==null)return out;
        for(int i=0;i<a.length();i++){JSONObject o=a.optJSONObject(i);if(o!=null){Movie m=Movie.from(o);if(m.score>=75)out.add(m);}}
        out.sort(Movie.ORDER); return out;
    }

    void setMovies(List<Movie> list){movies.clear();movies.addAll(list);}

    void applyFilter(){
        String q=norm(search==null?"":search.getText().toString()); shown.clear(); int cy=Calendar.getInstance().get(Calendar.YEAR);
        for(Movie m:movies){
            if(pref("hidden",m.id))continue;
            String hay=norm(m.display()+" "+m.title+" "+m.director+" "+String.join(" ",m.cast)+" "+String.join(" ",m.genres)+" "+String.join(" ",m.categories));
            if(!q.trim().isEmpty()&&!hay.contains(q))continue;
            if(!matches(m,filter,cy))continue; shown.add(m);
        }
        if(adapter!=null)adapter.notifyDataSetChanged();
        if(status!=null && !movies.isEmpty()) status.setText(shown.size()+" από "+movies.size()+" ταινίες • "+filter);
    }

    boolean matches(Movie m,String f,int cy){
        if("Όλες".equals(f))return true;
        if("Νέες προσθήκες".equals(f))return m.year>=cy-1||!m.greekDate.trim().isEmpty();
        if("80+".equals(f))return m.score>=80;
        if("75–79.9".equals(f))return m.score>=75&&m.score<80;
        if("Επανακυκλοφορίες".equals(f))return m.rerelease;
        if("GreekSubsMovies".equals(f))return m.greekSubsStatus.contains("Επιβεβαιωμένο");
        if("Αγαπημένα".equals(f))return pref("fav",m.id);
        if("Watchlist".equals(f))return pref("watch",m.id);
        if("Δεν έχω δει".equals(f))return !pref("watched",m.id);
        String hay=norm(String.join(" ",m.categories)+" "+String.join(" ",m.genres));
        if("Εγκλήματος / Αστυνομικές".equals(f))return hay.contains("εγκλη")||hay.contains("αστυνομ")||hay.contains("crime");
        return hay.contains(norm(f.replace("Κωμωδίες","Κωμωδία").replace("Κοινωνικές","Κοινων").replace("Ερωτικές / Ρομαντικές","Ρομαν")));
    }

    void showDetails(Movie m){
        Dialog d=new Dialog(this); d.getWindow();
        ScrollView scroll=new ScrollView(this); LinearLayout box=new LinearLayout(this); box.setOrientation(LinearLayout.VERTICAL); box.setPadding(dp(18),dp(18),dp(18),dp(24)); box.setBackgroundColor(BG); scroll.addView(box);
        ImageView hero=new ImageView(this); hero.setScaleType(ImageView.ScaleType.CENTER_CROP); box.addView(hero,new LinearLayout.LayoutParams(-1,dp(isTv?300:220))); ImageLoader.load(!m.background.trim().isEmpty()?m.background:m.poster,hero);
        box.addView(t(m.display(),isTv?30:25,TEXT,true)); if(!m.greekTitle.trim().isEmpty()&&!m.greekTitle.equalsIgnoreCase(m.title))box.addView(t(m.title,16,MUTED,false));
        String meta=String.format(Locale.US,"%.1f/100 • %d",m.score,m.year)+(m.runtime>0?" • "+m.runtime+"′":"")+(m.genres.isEmpty()?"":" • "+String.join(" / ",m.genres));
        box.addView(t(meta,16,Color.rgb(147,197,253),true));
        if(!m.greekDate.trim().isEmpty())box.addView(t((m.rerelease?"Επανακυκλοφορία Ελλάδας: ":"Κυκλοφορία Ελλάδας: ")+prettyDate(m.greekDate),16,Color.rgb(134,239,172),true));
        box.addView(t("Σκηνοθεσία: "+(m.director.trim().isEmpty()?"—":m.director),16,TEXT,false));
        if(!m.cast.isEmpty())box.addView(t("Πρωταγωνιστούν: "+String.join(", ",m.cast),15,MUTED,false));
        TextView desc=t(m.description.trim().isEmpty()?"Δεν υπάρχει ακόμη επιβεβαιωμένη περιγραφή. Θα προστεθεί αυτόματα όταν ενημερωθεί ο κατάλογος.":m.description,17,TEXT,false); desc.setPadding(0,dp(14),0,dp(14)); box.addView(desc);
        LinearLayout actions=new LinearLayout(this); actions.setOrientation(isTv?LinearLayout.HORIZONTAL:LinearLayout.VERTICAL); box.addView(actions);
        Button st=btn("▶ Stremio"); actions.addView(st); st.setOnClickListener(v->openStremio(m));
        Button gs=btn(m.greekSubsStatus.contains("Επιβεβαιωμένο")?"✓ GreekSubsMovies":"🔎 GreekSubsMovies"); actions.addView(gs); gs.setEnabled(!m.greekSubsUrl.trim().isEmpty()); gs.setOnClickListener(v->openWeb(m.greekSubsUrl));
        Button fi=btn("Film Index"); actions.addView(fi); fi.setEnabled(!m.filmIndexUrl.trim().isEmpty()); fi.setOnClickListener(v->openWeb(m.filmIndexUrl));
        Button tv=btn("🌐 TV Bro"); actions.addView(tv); tv.setOnClickListener(v->openWeb(m.greekSubsUrl.trim().isEmpty()?m.filmIndexUrl:m.greekSubsUrl));
        LinearLayout personal=new LinearLayout(this); personal.setOrientation(isTv?LinearLayout.HORIZONTAL:LinearLayout.VERTICAL); box.addView(personal);
        Button fav=btn(pref("fav",m.id)?"♥ Αγαπημένο":"♡ Αγαπημένο"),watch=btn(pref("watch",m.id)?"✓ Watchlist":"＋ Watchlist"),seen=btn(pref("watched",m.id)?"✓ Την είδα":"○ Την είδα"),hide=btn("⊘ Απόκρυψη");
        personal.addView(fav);personal.addView(watch);personal.addView(seen);personal.addView(hide);
        fav.setOnClickListener(v->{toggle("fav",m.id);fav.setText(pref("fav",m.id)?"♥ Αγαπημένο":"♡ Αγαπημένο");});
        watch.setOnClickListener(v->{toggle("watch",m.id);watch.setText(pref("watch",m.id)?"✓ Watchlist":"＋ Watchlist");});
        seen.setOnClickListener(v->{toggle("watched",m.id);seen.setText(pref("watched",m.id)?"✓ Την είδα":"○ Την είδα");});
        hide.setOnClickListener(v->{setPref("hidden",m.id,true);d.dismiss();applyFilter();});
        box.addView(t("Πηγή βαθμολογίας: "+m.scoreSources+"\nΔεδομένα: "+m.source+"\nWeb links: TV Bro → fallback browser",13,MUTED,false));
        Button close=btn("Κλείσιμο"); box.addView(close); close.setOnClickListener(v->d.dismiss());
        d.setContentView(scroll); Window w=d.getWindow(); if(w!=null){w.setBackgroundDrawable(new ColorDrawable(BG));w.setLayout(-1,-1);} d.show(); if(w!=null)w.setLayout(-1,-1);
    }

    void openStremio(Movie m){
        String uri=m.stremioAppUri.trim().isEmpty()?"stremio:///search?search="+Uri.encode(m.title+" "+m.year):m.stremioAppUri;
        try{startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(uri)));}
        catch(Exception e){String web=m.stremioWebUrl.trim().isEmpty()?"https://web.stremio.com/#/search?search="+Uri.encode(m.title+" "+m.year):m.stremioWebUrl;openWeb(web);}
    }

    void openWeb(String url){
        if(url==null||url.trim().isEmpty())return; Uri u=Uri.parse(url);
        Intent tv=new Intent(Intent.ACTION_VIEW,u); tv.setPackage(TV_BRO);
        try{startActivity(tv);return;}catch(Exception ignored){}
        try{startActivity(new Intent(Intent.ACTION_VIEW,u));}
        catch(Exception e){Toast.makeText(this,"Δεν βρέθηκε TV Bro ή browser",Toast.LENGTH_SHORT).show();}
    }

    boolean pref(String type,String id){return prefs.getBoolean(type+":"+id,false);}
    void setPref(String type,String id,boolean v){prefs.edit().putBoolean(type+":"+id,v).apply();}
    void toggle(String type,String id){setPref(type,id,!pref(type,id));}

    public static void scheduleSync(Context c){
        try{
            JobScheduler js=(JobScheduler)c.getSystemService(JOB_SCHEDULER_SERVICE);
            JobInfo j=new JobInfo.Builder(75075,new ComponentName(c,SyncJobService.class)).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPeriodic(24L*60*60*1000,4L*60*60*1000).setPersisted(true).build();
            js.schedule(j);
        }catch(Exception ignored){}
    }
    public static void syncInBackground(Context c,Runnable done){
        IO.execute(()->{try{ArrayList<Movie>x=downloadCatalog();saveCacheStatic(c,x);}catch(Exception ignored){} if(done!=null)new Handler(Looper.getMainLooper()).post(done);});
    }
    void saveCache(List<Movie>x){try{saveCacheStatic(this,x);}catch(Exception ignored){}}
    static void saveCacheStatic(Context c,List<Movie>x)throws Exception{JSONArray a=new JSONArray();for(Movie m:x)a.put(m.json());JSONObject r=new JSONObject();r.put("movies",a);File f=new File(c.getFilesDir(),"catalog_cache.json");try(Writer w=new OutputStreamWriter(new FileOutputStream(f),StandardCharsets.UTF_8)){w.write(r.toString());}}

    class MovieAdapter extends BaseAdapter{
        public int getCount(){return shown.size();} public Object getItem(int p){return shown.get(p);} public long getItemId(int p){return p;}
        public View getView(int pos,View old,android.view.ViewGroup parent){
            Movie m=shown.get(pos);
            if(listMode){
                LinearLayout row=new LinearLayout(MainActivity.this);row.setOrientation(LinearLayout.HORIZONTAL);row.setPadding(dp(8),dp(7),dp(8),dp(7));row.setBackgroundColor(PANEL);row.setGravity(Gravity.CENTER_VERTICAL);row.setFocusable(true);
                ImageView poster=new ImageView(MainActivity.this);poster.setScaleType(ImageView.ScaleType.CENTER_CROP);row.addView(poster,new LinearLayout.LayoutParams(dp(isTv?80:64),dp(isTv?116:92)));ImageLoader.load(m.poster,poster);
                LinearLayout txt=new LinearLayout(MainActivity.this);txt.setOrientation(LinearLayout.VERTICAL);txt.setPadding(dp(10),0,0,0);row.addView(txt,new LinearLayout.LayoutParams(0,-2,1));
                txt.addView(t(m.display(),isTv?20:17,TEXT,true));if(!m.greekTitle.trim().isEmpty()&&!m.greekTitle.equalsIgnoreCase(m.title))txt.addView(t(m.title,13,MUTED,false));
                txt.addView(t(String.format(Locale.US,"%.1f  |  %d  |  %s",m.score,m.year,m.genres.isEmpty()?"—":String.join(" / ",m.genres)),14,Color.rgb(147,197,253),false));
                txt.addView(t((m.director.trim().isEmpty()?"—":m.director)+(m.rerelease?"  |  ΕΠΑΝΑΚΥΚΛΟΦΟΡΙΑ":"")+(m.greekSubsStatus.contains("Επιβεβαιωμένο")?"  |  ✓ GreekSubsMovies":""),13,MUTED,false));
                return row;
            }else{
                LinearLayout card=new LinearLayout(MainActivity.this);card.setOrientation(LinearLayout.VERTICAL);card.setPadding(dp(5),dp(5),dp(5),dp(7));card.setBackgroundColor(PANEL);card.setFocusable(true);
                ImageView poster=new ImageView(MainActivity.this);poster.setScaleType(ImageView.ScaleType.CENTER_CROP);card.addView(poster,new LinearLayout.LayoutParams(-1,dp(isTv?245:225)));ImageLoader.load(m.poster,poster);
                TextView name=t(m.display(),isTv?18:16,TEXT,true);name.setMaxLines(2);card.addView(name);
                card.addView(t(String.format(Locale.US,"%.1f • %d%s",m.score,m.year,m.rerelease?" • Επανακυκλοφορία":""),13,Color.rgb(147,197,253),true));
                return card;
            }
        }
    }

    static class Movie{
        String id="",title="",greekTitle="",director="",description="",greekSubsStatus="",greekSubsUrl="",filmIndexUrl="",stremioWebUrl="",stremioAppUri="",poster="",background="",greekDate="",source="",scoreSources="";
        int year=0,runtime=0;double score=0;boolean rerelease=false;ArrayList<String>genres=new ArrayList<>(),categories=new ArrayList<>(),cast=new ArrayList<>();
        static final Comparator<Movie> ORDER=(a,b)->{int c=Double.compare(b.score,a.score);if(c!=0)return c;c=Integer.compare(b.year,a.year);return c!=0?c:a.title.compareToIgnoreCase(b.title);};
        String display(){return greekTitle.trim().isEmpty()?title:greekTitle;}
        static Movie from(JSONObject o){Movie m=new Movie();m.id=o.optString("id");m.title=o.optString("title",o.optString("originalName",o.optString("name")));m.greekTitle=o.optString("greekTitle");m.year=o.optInt("year");m.score=o.optDouble("score",o.optDouble("combinedScore",-1));m.scoreSources=o.optString("scoreSources");m.director=o.optString("director");if(o.opt("director")instanceof JSONArray)m.director=String.join(", ",strings(o.optJSONArray("director")));m.genres=strings(o.optJSONArray("genres"));m.categories=strings(o.optJSONArray("categories"));m.description=o.optString("description",o.optString("overview"));m.greekSubsStatus=o.optString("greekSubsStatus");m.greekSubsUrl=o.optString("greekSubsUrl");m.filmIndexUrl=o.optString("filmIndexUrl");m.stremioWebUrl=o.optString("stremioWebUrl");m.stremioAppUri=o.optString("stremioAppUri");m.poster=o.optString("poster");m.background=o.optString("background");m.cast=strings(o.optJSONArray("cast"));m.runtime=o.optInt("runtime",0);m.greekDate=o.optString("greekTheatricalDate");m.rerelease=o.optBoolean("isRerelease");m.source=o.optString("source");return m;}
        JSONObject json(){JSONObject o=new JSONObject();try{o.put("id",id);o.put("title",title);o.put("greekTitle",greekTitle);o.put("year",year);o.put("score",score);o.put("scoreSources",scoreSources);o.put("director",director);o.put("genres",new JSONArray(genres));o.put("categories",new JSONArray(categories));o.put("description",description);o.put("greekSubsStatus",greekSubsStatus);o.put("greekSubsUrl",greekSubsUrl);o.put("filmIndexUrl",filmIndexUrl);o.put("stremioWebUrl",stremioWebUrl);o.put("stremioAppUri",stremioAppUri);o.put("poster",poster);o.put("background",background);o.put("cast",new JSONArray(cast));o.put("runtime",runtime);o.put("greekTheatricalDate",greekDate);o.put("isRerelease",rerelease);o.put("source",source);}catch(Exception ignored){}return o;}
    }

    static class ImageLoader{
        static final android.util.LruCache<String,Bitmap>CACHE=new android.util.LruCache<String,Bitmap>(24*1024*1024){protected int sizeOf(String k,Bitmap b){return b.getByteCount();}};
        static void load(String url,ImageView v){if(url==null||url.trim().isEmpty()){v.setImageDrawable(null);return;}v.setTag(url);Bitmap b=CACHE.get(url);if(b!=null){v.setImageBitmap(b);return;}v.setImageDrawable(null);IO.execute(()->{HttpURLConnection c=null;try{c=(HttpURLConnection)new URL(url).openConnection();c.setConnectTimeout(8000);c.setReadTimeout(10000);try(InputStream in=c.getInputStream()){Bitmap x=BitmapFactory.decodeStream(in);if(x!=null)CACHE.put(url,x);v.post(()->{if(url.equals(v.getTag())&&x!=null)v.setImageBitmap(x);});}}catch(Exception ignored){}finally{if(c!=null)c.disconnect();}});}
    }

    TextView t(String s,float sp,int color,boolean bold){TextView v=new TextView(this);v.setText(s);v.setTextSize(sp);v.setTextColor(color);if(bold)v.setTypeface(null,Typeface.BOLD);v.setPadding(dp(3),dp(4),dp(3),dp(4));return v;}
    Button btn(String s){Button b=new Button(this);b.setText(s);b.setTextColor(Color.WHITE);b.setBackgroundColor(PANEL);b.setAllCaps(false);b.setFocusable(true);return b;}
    int dp(int n){return (int)(n*getResources().getDisplayMetrics().density+.5f);}
    static String prettyDate(String d){String[]p=d.split("-");return p.length==3?p[2]+"/"+p[1]+"/"+p[0]:d;}
    static String key(String t,int y){return norm(t)+"|"+y;}
    static String norm(String s){if(s==null)return"";String n=Normalizer.normalize(s,Normalizer.Form.NFD).replaceAll("\\p{M}+","").toLowerCase(Locale.ROOT);return n.replaceAll("[^\\p{L}\\p{N}]+"," ").trim();}
    static ArrayList<String> strings(JSONArray a){ArrayList<String>x=new ArrayList<>();if(a!=null)for(int i=0;i<a.length();i++){String s=a.optString(i);if(!s.trim().isEmpty())x.add(s);}return x;}
    static String fetch(String url)throws Exception{HttpURLConnection c=(HttpURLConnection)new URL(url).openConnection();c.setConnectTimeout(12000);c.setReadTimeout(25000);c.setRequestProperty("User-Agent","Cine75/1.0.2");int code=c.getResponseCode();if(code<200||code>=300)throw new IOException("HTTP "+code);try{return read(c.getInputStream());}finally{c.disconnect();}}
    static String read(InputStream in)throws IOException{try(in){ByteArrayOutputStream b=new ByteArrayOutputStream();byte[]buf=new byte[8192];int n;while((n=in.read(buf))!=-1)b.write(buf,0,n);return b.toString(StandardCharsets.UTF_8);}}
    static String gunzipBase64(String s)throws Exception{byte[]gz=android.util.Base64.decode(s.trim(),android.util.Base64.DEFAULT);return read(new GZIPInputStream(new ByteArrayInputStream(gz)));}
}
