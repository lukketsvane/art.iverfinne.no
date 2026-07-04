import { supabase } from '$lib/supabase';
import type { NearbyTag, PlacementPose, Profile, SizeClass } from '$lib/types';

export async function getProfile(userId: string): Promise<Profile> {
	const { data, error } = await supabase()
		.from('profiles')
		.select('id, handle, total_volume, used_volume')
		.eq('id', userId)
		.single();
	if (error) throw error;
	return data as Profile;
}

export async function nearbyTags(lat: number, lon: number, radiusM = 150): Promise<NearbyTag[]> {
	const { data, error } = await supabase().rpc('nearby_tags', {
		p_lat: lat,
		p_lon: lon,
		p_radius_m: radiusM
	});
	if (error) throw error;
	return (data ?? []) as NearbyTag[];
}

export async function placeTag(
	pose: PlacementPose,
	modelUrl: string,
	sizeClass: SizeClass
): Promise<NearbyTag> {
	const { data, error } = await supabase().rpc('place_tag', {
		p_lat: pose.lat,
		p_lon: pose.lon,
		p_alt: pose.alt,
		p_heading: pose.heading,
		p_accuracy: pose.accuracy,
		p_model_url: modelUrl,
		p_size_class: sizeClass,
		p_device: { ua: navigator.userAgent, placed_via: 'sensor-ar-web-mvp' }
	});
	if (error) throw error;
	// place_tag returns a tags row; adapt it to the NearbyTag shape for the scene.
	const t = data as {
		id: string; creator_id: string; heading: number | null; accuracy_m: number | null;
		model_url: string; size_class: SizeClass; created_at: string;
	};
	return {
		id: t.id,
		creator_id: t.creator_id,
		lat: pose.lat,
		lon: pose.lon,
		alt: pose.alt ?? 0,
		heading: t.heading,
		accuracy_m: t.accuracy_m,
		model_url: t.model_url,
		size_class: t.size_class,
		distance_m: 0,
		appraisals: 0,
		appraised: false,
		created_at: t.created_at
	};
}

/** Fetch one tag by id (share links / focus mode). distance_m is filled by the caller. */
export async function getTag(tagId: string): Promise<NearbyTag | null> {
	const { data, error } = await supabase().rpc('get_tag', { p_tag_id: tagId });
	if (error) throw error;
	const row = Array.isArray(data) ? data[0] : data;
	if (!row) return null;
	return { ...row, distance_m: 0, appraised: Boolean(row.appraised) } as NearbyTag;
}

export async function appraiseTag(tagId: string): Promise<void> {
	const { error } = await supabase().rpc('appraise_tag', { p_tag_id: tagId });
	if (error) throw error;
}

export async function reportTag(tagId: string, reason?: string): Promise<void> {
	const { error } = await supabase().rpc('report_tag', { p_tag_id: tagId, p_reason: reason ?? null });
	if (error) throw error;
}
