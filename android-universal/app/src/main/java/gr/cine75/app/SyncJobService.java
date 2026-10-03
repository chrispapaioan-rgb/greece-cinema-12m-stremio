package gr.cine75.app;
import android.app.job.JobParameters;
import android.app.job.JobService;
public class SyncJobService extends JobService {
    @Override public boolean onStartJob(JobParameters p){
        MainActivity.syncInBackground(this, () -> jobFinished(p,false));
        return true;
    }
    @Override public boolean onStopJob(JobParameters p){ return true; }
}
